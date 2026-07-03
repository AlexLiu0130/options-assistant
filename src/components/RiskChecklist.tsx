import { AgGridReact } from 'ag-grid-react'
import { riskRows } from '../core/dashboardData'
import type { StrategyCandidate } from '../types/strategyTypes'

export function RiskChecklist({ strategies }: { strategies: StrategyCandidate[] }) {
  return (
    <div className="ag-theme-quartz-dark terminal-grid compact-grid">
      <AgGridReact
        rowData={riskRows(strategies)}
        columnDefs={[
          { field: 'strategy', headerName: 'Strategy', flex: 1.1 },
          { field: 'check', headerName: 'Check', flex: 1 },
          { field: 'severity', headerName: 'Severity', flex: 0.8 },
          { field: 'detail', headerName: 'Detail', flex: 2.6 },
        ]}
        defaultColDef={{ sortable: true, resizable: true, filter: true }}
        theme="legacy"
      />
    </div>
  )
}
