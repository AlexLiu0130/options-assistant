#!/usr/bin/env python3
import argparse
import json
import math
import threading
import time
from datetime import datetime, timezone

from ibapi.client import EClient
from ibapi.common import TickerId
from ibapi.contract import Contract
from ibapi.wrapper import EWrapper


def finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value) and value > -1e100


def valid_price(value):
    return finite(value) and value >= 0


def option_symbol(ticker, expiry, right, strike):
    code = "C" if right == "call" else "P"
    return f"{ticker}{expiry[2:].replace('-', '')}{code}{int(round(strike * 1000)):08d}"


class IbkrApp(EWrapper, EClient):
    def __init__(self):
        EClient.__init__(self, self)
        self.ready = threading.Event()
        self.stock_details = []
        self.secdef = []
        self.ticks = {}
        self.history = {}
        self.errors = []

    def nextValidId(self, orderId: int):
        self.ready.set()

    def error(self, reqId, errorCode, errorString, advancedOrderRejectJson=""):
        if errorCode not in {2104, 2106, 2158, 2108, 2119}:
            if reqId >= 0:
                self.ticks.setdefault(reqId, {})["done"] = True
            self.errors.append({"reqId": reqId, "code": errorCode, "message": errorString})

    def contractDetails(self, reqId, contractDetails):
        self.stock_details.append(contractDetails)

    def contractDetailsEnd(self, reqId):
        self.ticks.setdefault(reqId, {})["done"] = True

    def securityDefinitionOptionParameter(
        self,
        reqId,
        exchange,
        underlyingConId,
        tradingClass,
        multiplier,
        expirations,
        strikes,
    ):
        self.secdef.append(
            {
                "exchange": exchange,
                "underlyingConId": underlyingConId,
                "tradingClass": tradingClass,
                "multiplier": multiplier,
                "expirations": sorted(expirations),
                "strikes": sorted(float(strike) for strike in strikes if float(strike) > 0),
            }
        )

    def securityDefinitionOptionParameterEnd(self, reqId):
        self.ticks.setdefault(reqId, {})["done"] = True

    def tickPrice(self, reqId: TickerId, tickType: int, price: float, attrib):
        row = self.ticks.setdefault(reqId, {})
        if not valid_price(price):
            return
        if tickType == 1:
            row["bid"] = price
        elif tickType == 2:
            row["ask"] = price
        elif tickType == 4:
            row["last"] = price
        elif tickType == 6:
            row["high"] = price
        elif tickType == 7:
            row["low"] = price
        elif tickType == 9:
            row["previousClose"] = price
        elif tickType == 14:
            row["open"] = price

    def tickSize(self, reqId: TickerId, tickType: int, size: int):
        row = self.ticks.setdefault(reqId, {})
        if tickType == 0:
            row["bidSize"] = size
        elif tickType == 3:
            row["askSize"] = size
        elif tickType == 5:
            row["lastSize"] = size
        elif tickType == 8:
            row["volume"] = size
        elif tickType in {27, 28}:
            row["openInterest"] = size

    def tickOptionComputation(
        self,
        reqId,
        tickType,
        tickAttrib,
        impliedVol,
        delta,
        optPrice,
        pvDividend,
        gamma,
        vega,
        theta,
        undPrice,
    ):
        row = self.ticks.setdefault(reqId, {})
        if finite(impliedVol):
            row["impliedVolatility"] = impliedVol
        if finite(delta):
            row["delta"] = delta
        if finite(gamma):
            row["gamma"] = gamma
        if finite(vega):
            row["vega"] = vega
        if finite(theta):
            row["theta"] = theta
        if finite(undPrice):
            row["underlyingPrice"] = undPrice

    def tickSnapshotEnd(self, reqId: int):
        self.ticks.setdefault(reqId, {})["done"] = True

    def historicalData(self, reqId, bar):
        rows = self.history.setdefault(reqId, [])
        date_text = str(bar.date)
        if len(date_text) == 8 and date_text.isdigit():
            time_text = f"{date_text[:4]}-{date_text[4:6]}-{date_text[6:8]}"
        else:
            time_text = date_text.split(" ")[0]
        rows.append(
            {
                "time": time_text,
                "open": float(bar.open),
                "high": float(bar.high),
                "low": float(bar.low),
                "close": float(bar.close),
                "volume": int(bar.volume) if finite(bar.volume) else None,
            }
        )

    def historicalDataEnd(self, reqId, start, end):
        self.ticks.setdefault(reqId, {})["done"] = True


def wait_until(predicate, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def centered_window(items, center, count):
    if count >= len(items):
        return items
    start = max(0, min(center - count // 2, len(items) - count))
    return items[start:start + count]


def has_stock_snapshot(tick):
    return tick.get("done") or any(key in tick for key in ("last", "bid", "ask", "previousClose"))


def has_option_snapshot(tick):
    return tick.get("done") or any(key in tick for key in ("bid", "ask", "last", "impliedVolatility", "delta"))


def trim_contracts_near_spot(contracts, spot, strike_count):
    result = []
    for expiry in sorted({contract["expiration"] for contract in contracts}):
        rows = [contract for contract in contracts if contract["expiration"] == expiry]
        keep = set(sorted({row["strike"] for row in rows}, key=lambda strike: abs(strike - spot))[:strike_count])
        result.extend(row for row in rows if row["strike"] in keep)
    return sorted(result, key=lambda row: (row["expiration"], row["strike"], row["right"]))


def stock_contract(ticker):
    contract = Contract()
    contract.symbol = ticker
    contract.secType = "STK"
    contract.exchange = "SMART"
    contract.currency = "USD"
    return contract


def option_contract(ticker, expiry, strike, right, trading_class=""):
    contract = Contract()
    contract.symbol = ticker
    contract.secType = "OPT"
    contract.exchange = "SMART"
    contract.currency = "USD"
    contract.lastTradeDateOrContractMonth = expiry.replace("-", "")
    contract.strike = float(strike)
    contract.right = "C" if right == "call" else "P"
    contract.multiplier = "100"
    if trading_class:
        contract.tradingClass = trading_class
    return contract


def normalize_market(ticker, tick):
    bid = tick.get("bid")
    ask = tick.get("ask")
    if finite(tick.get("last")):
        price = tick.get("last")
    elif finite(bid) and finite(ask):
        price = (bid + ask) / 2
    elif finite(bid):
        price = bid
    elif finite(ask):
        price = ask
    else:
        price = tick.get("previousClose")
    previous = tick.get("previousClose")
    change = price - previous if finite(price) and finite(previous) else None
    return {
        "ticker": ticker,
        "price": price,
        "open": tick.get("open"),
        "high": tick.get("high"),
        "low": tick.get("low"),
        "previousClose": previous,
        "change": change,
        "changePercent": (change / previous * 100) if finite(change) and finite(previous) and previous else None,
        "volume": tick.get("volume"),
        "timestamp": int(time.time()),
        "source": "IBKR",
        "asOf": datetime.now(timezone.utc).isoformat(),
        "marketDataType": "frozen",
    }


def expiry_dte(expiry, today_dt):
    return (datetime.strptime(expiry, "%Y%m%d").date() - today_dt).days


def select_expiries(expiries, today_dt, min_dte, limit):
    eligible = sorted(
        expiry for expiry in expiries
        if expiry >= today_dt.strftime("%Y%m%d") and expiry_dte(expiry, today_dt) >= min_dte
    )
    if not eligible or limit <= 0:
        return []
    targets = [14, 30, 45, 60, 90, 120, 180, 270]
    selected = []
    for target in targets:
        remaining = [expiry for expiry in eligible if expiry not in selected]
        if not remaining or len(selected) >= limit:
            break
        selected.append(min(remaining, key=lambda expiry: (abs(expiry_dte(expiry, today_dt) - target), expiry_dte(expiry, today_dt))))
    for expiry in eligible:
        if len(selected) >= limit:
            break
        if expiry not in selected:
            selected.append(expiry)
    return sorted(selected)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("ticker", nargs="?", default="NVDA")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4001)
    parser.add_argument("--client-id", type=int, default=9100 + int(time.time() * 1000) % 800)
    parser.add_argument("--expirations", type=int, default=8)
    parser.add_argument("--strikes", type=int, default=25)
    parser.add_argument("--min-dte", type=int, default=7)
    parser.add_argument("--history-duration", default="3 M")
    parser.add_argument("--history-bar-size", default="1 day")
    parser.add_argument("--timeout", type=float, default=12)
    parser.add_argument("--debug-secdef", action="store_true")
    args = parser.parse_args()

    ticker = "".join(ch for ch in args.ticker.upper() if ch.isalnum() or ch in ".-")
    app = IbkrApp()
    app.connect(args.host, args.port, clientId=args.client_id)
    thread = threading.Thread(target=app.run, daemon=True)
    thread.start()

    def finish(payload):
        try:
            app.disconnect()
        finally:
            print(json.dumps(payload, indent=2, allow_nan=False))
        return 0

    if not app.ready.wait(args.timeout):
        return finish({"status": "unavailable", "message": "IBKR API did not return nextValidId."})

    app.reqMarketDataType(2)

    app.reqContractDetails(1, stock_contract(ticker))
    wait_until(lambda: app.ticks.get(1, {}).get("done"), args.timeout)
    if not app.stock_details:
        return finish({"status": "unavailable", "message": f"IBKR contract details not found for {ticker}.", "errors": app.errors})

    stock = app.stock_details[0].contract
    app.reqMktData(2, stock, "", True, False, [])
    wait_until(lambda: has_stock_snapshot(app.ticks.get(2, {})), args.timeout)
    market = normalize_market(ticker, app.ticks.get(2, {}))

    skip_history = str(args.history_duration).strip().lower() in {"0", "none", "skip"}
    candles = []
    if not skip_history:
        app.reqHistoricalData(4, stock, "", args.history_duration, args.history_bar_size, "TRADES", 1, 1, False, [])
        wait_until(lambda: app.ticks.get(4, {}).get("done"), max(args.timeout, 15))
        candles = app.history.get(4, [])
        if candles:
            market["candles"] = candles[-90:]
    spot = market.get("price")
    if not finite(spot):
        spot = candles[-1]["close"] if candles else None
        market["price"] = spot

    app.reqSecDefOptParams(3, ticker, "", "STK", stock.conId)
    wait_until(lambda: app.ticks.get(3, {}).get("done"), args.timeout)
    candidates = [row for row in app.secdef if row["expirations"] and row["strikes"]]
    candidates.sort(
        key=lambda row: (
            row.get("tradingClass") == ticker,
            row.get("exchange") in {"SMART", "BOX", "CBOE", "EDGX"},
            len(row["strikes"]),
            len(row["expirations"]),
        ),
        reverse=True,
    )
    params = candidates[0] if candidates else None
    if not params:
        return finish({"status": "unavailable", "market": market, "message": "IBKR option parameters unavailable.", "errors": app.errors})
    if args.debug_secdef:
        return finish({"status": "debug", "market": market, "secdef": app.secdef, "errors": app.errors})

    today_dt = datetime.now(timezone.utc).date()
    expiries = select_expiries(params["expirations"], today_dt, args.min_dte, args.expirations)
    all_strikes = params["strikes"]
    if not finite(spot):
        return finish({"status": "unavailable", "market": market, "message": "IBKR underlying price unavailable.", "errors": app.errors})
    center = min(range(len(all_strikes)), key=lambda idx: abs(all_strikes[idx] - spot))
    strikes = centered_window(all_strikes, center, min(len(all_strikes), args.strikes * 4))

    requests = {}
    req_id = 10
    for expiry in expiries:
        normalized_expiry = f"{expiry[:4]}-{expiry[4:6]}-{expiry[6:8]}"
        for strike in strikes:
            for right in ("call", "put"):
                contract = option_contract(ticker, expiry, strike, right, params.get("tradingClass") or "")
                requests[req_id] = (normalized_expiry, strike, right)
                app.reqMktData(req_id, contract, "", True, False, [])
                req_id += 1

    wait_until(
        lambda: sum(1 for req in requests if has_option_snapshot(app.ticks.get(req, {}))) >= max(1, int(len(requests) * 0.8)),
        max(args.timeout, 15),
    )

    contracts = []
    for request_id, (expiry, strike, right) in requests.items():
        tick = app.ticks.get(request_id, {})
        if not any(key in tick for key in ("bid", "ask", "last", "impliedVolatility", "delta")):
            continue
        contracts.append(
            {
                "symbol": option_symbol(ticker, expiry, right, strike),
                "underlying": ticker,
                "quoteDate": datetime.now(timezone.utc).date().isoformat(),
                "expiration": expiry,
                "strike": strike,
                "right": right,
                "bid": tick.get("bid"),
                "ask": tick.get("ask"),
                "last": tick.get("last"),
                "bidSize": tick.get("bidSize"),
                "askSize": tick.get("askSize"),
                "openInterest": tick.get("openInterest"),
                "volume": tick.get("volume"),
                "impliedVolatility": tick.get("impliedVolatility"),
                "delta": tick.get("delta"),
                "gamma": tick.get("gamma"),
                "vega": tick.get("vega"),
                "theta": tick.get("theta"),
            }
        )
    contracts = trim_contracts_near_spot(contracts, spot, args.strikes)

    output = {
        "ticker": ticker,
        "status": "available" if contracts else "unavailable",
        "mode": "ibkr_frozen",
        "market": market,
        "contracts": contracts,
        "asOf": datetime.now(timezone.utc).isoformat(),
        "message": "IBKR frozen market data normalized." if contracts else "IBKR returned no option market data.",
        "dataGaps": [
            "IBKR_FROZEN_DATA: requested via reqMarketDataType(2); values may be from prior close/outside regular trading hours.",
            "IBKR_DATA_GAP: missing bid/ask/greeks are left null; no synthetic fill.",
        ],
        "errors": app.errors[-8:],
    }
    return finish(output)


if __name__ == "__main__":
    main()
