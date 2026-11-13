// No build step: Orca strips the types and compiles the JSX when the panel loads.
import { atom, Heading, plugin, read, set, Stack, Tab, Tabs, type PanelContext } from 'orca'
import { loadQuota, QuotaView, snapshot } from './quota-view'
import { loadUsage, UsageView } from './usage-view'

const tab = atom('usage')

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('usage.updated', () => void loadUsage()),
    plugin.on('quota.updated', (next) => set(snapshot, next))
  )
  void loadUsage()
  void loadQuota(false)
}

export default function Panel() {
  return (
    <Stack gap="md">
      <Heading>Agent Usage</Heading>
      <Tabs label="View" value={read(tab)} onChange={(value) => set(tab, value)}>
        <Tab value="usage" label="Usage" icon="bar-chart-3">
          <UsageView />
        </Tab>
        <Tab value="quota" label="Quota" icon="gauge">
          <QuotaView />
        </Tab>
      </Tabs>
    </Stack>
  )
}
