import AuditLogsPage from './AuditLogsPage';

/* 
 * ┌──── AuditLogsPage — 8 states ────────────────┐
 * │                                              │
 * │ default       [ Rendered below          ]    │
 * │ hover         [ Use mouse               ]    │
 * │ focus         [ Use keyboard (Tab)      ]    │
 * │ active        [ Use mouse click         ]    │
 * │ disabled      [ Action without metadata ]    │
 * │ loading       [ Handled by useResource  ]    │
 * │ error         [ Handled by useResource  ]    │
 * │ empty         [ Handled by useResource  ]    │
 * │ success       [ Rendered below          ]    │
 * │                                              │
 * └──────────────────────────────────────────────┘
 * 
 * Note: AuditLogsPage uses the `useResource` hook which handles data fetching. 
 * To see the different states (loading, empty, error), you can temporarily modify 
 * the `/audit-logs` endpoint response or intercept the fetch call.
 */

export default function AuditLogsPagePreview() {
  return (
    <div className="min-h-screen bg-background p-s6">
      <div className="mx-auto max-w-5xl space-y-s8">
        <section>
          <h2 className="mb-s4 text-lg font-bold text-muted-foreground border-b border-border pb-s2">
            1. Loaded State (Success, Default, Hover, Focus, Active, Disabled actions)
          </h2>
          <div className="rounded-card border-2 border-border bg-background p-s4">
            <AuditLogsPage />
          </div>
        </section>
      </div>
    </div>
  );
}
