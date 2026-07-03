import { AgGridReact } from 'ag-grid-react'
import { money, scenarioRows } from '../core/dashboardData'
import type { StrategyCandidate } from '../types/strategyTypes'

export function ScenarioTable({ strategies }: { strategies: StrategyCandidate[] }) {
  return (
    <div className="ag-theme-quartz-dark terminal-grid compact-grid">
      <AgGridReact
        rowData={scenarioRows(strategies)}
        columnDefs={[
          { field: 'strategy', headerName: 'Strategy', flex: 1.2 },
          { field: 'scenario', headerName: 'Scenario', flex: 1 },
          { field: 'underlyingPrice', headerName: 'Underlying', valueFormatter: ({ value }) => money(value), flex: 1 },
          { field: 'estimatedPl', headerName: 'P/L', valueFormatter: ({ value }) => money(value), flex: 1 },
          { field: 'meaning', headerName: 'Meaning', flex: 2 },
        ]}
        defaultColDef={{ sortable: true, resizable: true, filter: true }}
        theme="legacy"
      />
    </div>
  )
}
