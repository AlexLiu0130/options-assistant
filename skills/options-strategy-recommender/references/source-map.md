# Source Map

This reference maps the local `book/` PDFs plus public education resources to the skill's internal use. Do not quote long passages. Use these sources to shape neutral educational explanations and strategy heuristics.

## Local Book Folder

- `book/options-as-a-strategic-investment-fifth-edition-5nbsped-0735204659-9780735204652_compress.pdf`
- `book/Mcgraw-Hill - Option Pricing And Volatility - Advanced Strategies And Trading Techniques - Sheldon Natenberg - (1994).pdf`
- `book/Options, Futures and Other Derivatives 8th John Hull.pdf`
- `book/optionsplaybook.pdf`
- `book/trading option greeks.pdf`

Extraction notes:

- McMillan and Hull provide usable table-of-contents text and broad structure.
- Options Playbook provides beginner-friendly strategy framing and risk disclaimers.
- Trading Option Greeks appears to be a short excerpt or front-matter/contents sample in this folder; use it for scope mapping, not exhaustive extraction.
- Natenberg is an encrypted/scanned PDF with weak text extraction; use it as a volatility-pricing source map, not as copied text.

## Core Strategy Sources

### Options as a Strategic Investment

- Author: Lawrence G. McMillan.
- Use for: strategy taxonomy, covered calls, protective puts, spreads, risk/reward framing.
- Local distillation: strategy formulas and follow-up/risk framing in `strategy-dictionary.md`.
- Public source: https://www.optionstrategist.com/products/options-strategic-investment-5th-edition

### Options Playbook

- Author: Brian Overby with R. Burt.
- Use for: beginner explanations, plain-language strategy cards, and options-risk framing.
- Local distillation: plain-English templates in `scenario-explainer.md`.

### The Bible of Options Strategies

- Author: Guy Cohen.
- Use for: strategy dictionary structure and practical strategy categorization.
- Public source: https://www.pearson.com/en-us/subject-catalog/p/bible-of-options-strategies-the-definitive-guide-for-practical-trading-strategies/P200000003126

## Volatility And Greeks Sources

### Option Volatility and Pricing

- Author: Sheldon Natenberg.
- Use for: IV, skew, volatility, Greeks, and why direction can be right while premium still loses.
- Local distillation: qualitative volatility and IV-crush rules in `greeks-volatility.md`.
- Public source: https://www.mhprofessional.com/option-volatility-and-pricing-9780071818773-usa

### Trading Options Greeks

- Author: Dan Passarelli.
- Use for: delta/gamma/theta/vega explanations and risk checklist language.
- Local distillation: Greeks explanations and strategy exposure table in `greeks-volatility.md`.
- Public source: https://www.wiley.com/en-us/Trading+Options+Greeks%3A+How+Time%2C+Volatility%2C+and+Other+Pricing+Factors+Drive+Profits%2C+2nd+Edition-p-9781118133163

### Options, Futures, and Other Derivatives

- Author: John C. Hull.
- Use for: formal payoff, derivative, pricing, and risk-neutral concepts.
- Local distillation: payoff formulas, scenario math, and Greeks concepts in `scenario-explainer.md` and `greeks-volatility.md`.
- Public source: https://www.pearson.com/en-us/subject-catalog/p/options-futures-and-other-derivatives/P200000006572

## Risk And Education Sources

### OCC / OIC Options Education

- Use for: neutral beginner education and options basics.
- Public source: https://www.optionseducation.org/

### Cboe Options Institute

- Use for: options education path, strategy learning, market structure framing.
- Public source: https://www.cboe.com/optionsinstitute/

### FINRA Options Investor Education

- Use for: investor protection, risk disclosure tone, education-not-advice boundaries.
- Public source: https://www.finra.org/investors/investing/investment-products/options

## Product Knowledge Distillation Rules

- Convert sources into concise product heuristics, not copied text.
- Keep reference files usable by any model; avoid Codex-only assumptions outside `SKILL.md`.
- Keep user-facing explanations plain English.
- Use source-backed caution for leverage, assignment, liquidity, short-dated risk, and volatility risk.
- Treat complex strategies as education-first until the MVP engine and QVeris data support them.
