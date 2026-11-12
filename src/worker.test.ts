// Runs src/worker.ts's activate(orca) over a mock host with every source off, so nothing leaves
// the machine.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

const OFF = {
  claude: false,
  codex: false,
  grok: false,
  copilot: false,
  openrouter: false,
  deepseek: false,
  readAgentConfigs: false,
  nineRouterUrl: ''
}

test('answers a snapshot, stores it and updates the status bar', async () => {
  const host = mockHost({ capabilities: ['storage:own', 'settings:own', 'secrets:own'], settings: OFF })
  const worker = await mountWorker(main, { host, commands: ['quota.refresh'] })
  try {
    const snapshot = await worker.request('quota.get', { refresh: true })
    assert.deepEqual(snapshot?.accounts, [])
    assert.deepEqual(snapshot?.notes, [])
    assert.ok(host.data().storage['snapshot:v1'])
    const updates = host.callsOf('statusBar.update')
    assert.ok(updates.length > 0, JSON.stringify(host.calls))
    assert.deepEqual(updates.at(-1), {
      id: 'quota',
      text: 'Quota',
      tone: 'neutral',
      tooltip: 'No quota sources found yet'
    })
    assert.equal(await worker.command('quota.refresh'), 'No quota sources found yet')
    assert.deepEqual(worker.refusals, [], JSON.stringify(host.calls))
  } finally {
    await worker.deactivate()
  }
})
