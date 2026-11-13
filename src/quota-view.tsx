// The Quota tab: plan limits and credits per provider, and the keys the worker cannot find itself.
import {
  atom,
  Badge,
  Button,
  Callout,
  Collapsible,
  EmptyState,
  IconButton,
  Input,
  plugin,
  Progress,
  read,
  RelativeTime,
  Row,
  secrets,
  Separator,
  set,
  Skeleton,
  Stack,
  Text
} from 'orca'
import { SECRET_KEYS, type QuotaAccount, type QuotaSnapshot, type QuotaWindow } from './protocol'
import { accountHeadroom, summarize, toneFor, type ProviderSummary } from './summary'

export const snapshot = atom<QuotaSnapshot | null>(null)
const loading = atom(false)
const failure = atom<string | null>(null)
const drafts = atom<Record<string, string>>({})
const saved = atom<string | null>(null)

// More per-model windows than this fold into their own section.
const MODEL_WINDOWS_INLINE = 4

const KEY_FIELDS: { key: string; label: string; placeholder: string }[] = [
  { key: SECRET_KEYS.nineRouterToken, label: '9router CLI token', placeholder: 'x-9r-cli-token value' },
  { key: SECRET_KEYS.openRouterKey, label: 'OpenRouter API key', placeholder: 'sk-or-…' },
  { key: SECRET_KEYS.deepSeekKey, label: 'DeepSeek API key', placeholder: 'sk-…' }
]

export async function loadQuota(refresh: boolean): Promise<void> {
  set(loading, true)
  try {
    set(snapshot, await plugin.request('quota.get', { refresh }, { timeoutMs: 120_000 }))
    set(failure, null)
  } catch (error) {
    set(failure, error instanceof Error ? error.message : String(error))
  } finally {
    set(loading, false)
  }
}

async function saveKey(key: string, label: string): Promise<void> {
  const value = (read(drafts)[key] ?? '').trim()
  if (value) {
    await secrets.set(key, value)
  } else {
    await secrets.delete(key)
  }
  set(drafts, { ...read(drafts), [key]: '' })
  set(saved, value ? `${label} saved` : `${label} removed`)
  await loadQuota(true)
}

function WindowRow({ window }: { window: QuotaWindow }) {
  const left = window.usedPercent === null ? null : 100 - window.usedPercent
  return (
    <Stack gap="xs">
      <Row justify="between" gap="sm">
        <Text size="sm" truncate>
          {window.label}
        </Text>
        <Text size="xs" muted>
          {left === null ? '' : `${Math.round(left)}% left`}
          {window.detail ? ` · ${window.detail}` : ''}
          {window.resetsAt ? ' · resets ' : ''}
          {window.resetsAt ? <RelativeTime at={window.resetsAt} format="short" /> : null}
        </Text>
      </Row>
      {window.usedPercent === null ? null : (
        <Progress label={`${window.label} used`} labelHidden value={window.usedPercent} />
      )}
    </Stack>
  )
}

function AccountView({ account }: { account: QuotaAccount }) {
  const accountWide = account.windows.filter((window) => window.scope === 'account')
  const perModel = account.windows.filter((window) => window.scope === 'model')
  return (
    <Stack gap="xs">
      <Row justify="between" gap="sm">
        <Row gap="xs">
          <Text weight="medium" truncate>
            {account.account}
          </Text>
          {account.plan ? <Badge>{account.plan}</Badge> : null}
        </Row>
        <Text size="xs" muted truncate>
          {account.source}
        </Text>
      </Row>
      {account.error ? (
        <Text size="sm" tone="danger">
          {account.error}
        </Text>
      ) : null}
      {account.balance ? <Text size="sm">{account.balance}</Text> : null}
      {accountWide.map((window) => (
        <WindowRow window={window} />
      ))}
      {perModel.length > 0 && perModel.length <= MODEL_WINDOWS_INLINE
        ? perModel.map((window) => <WindowRow window={window} />)
        : null}
      {perModel.length > MODEL_WINDOWS_INLINE ? (
        <Collapsible title={`${perModel.length} model limits`}>
          <Stack gap="sm">
            {perModel.map((window) => (
              <WindowRow window={window} />
            ))}
          </Stack>
        </Collapsible>
      ) : null}
      {!account.error && !account.balance && account.windows.length === 0 ? (
        <Text size="sm" muted>
          No limits reported
        </Text>
      ) : null}
    </Stack>
  )
}

function summaryLine(summary: ProviderSummary): string {
  const parts = [
    summary.best ? `${Math.round(summary.best.remaining)}% left` : 'no limit data',
    summary.accounts > 1 ? `${summary.accounts} accounts` : '',
    summary.errors > 0 ? `${summary.errors} failing` : ''
  ]
  return parts.filter(Boolean).join(' · ')
}

/** Most headroom first, so the account a router would pick next is on top; failures last. */
function byHeadroom(a: QuotaAccount, b: QuotaAccount): number {
  return (accountHeadroom(b)?.remaining ?? -1) - (accountHeadroom(a)?.remaining ?? -1)
}

function ProviderView({ summary, accounts }: { summary: ProviderSummary; accounts: QuotaAccount[] }) {
  const tone = summary.best ? toneFor(summary.best.remaining) : 'neutral'
  return (
    <Collapsible
      title={summary.provider}
      description={summaryLine(summary)}
      defaultOpen={accounts.length <= 3}
    >
      <Stack gap="md">
        {tone === 'danger' ? (
          <Callout tone="danger" icon="warning">
            {accounts.length > 1
              ? `Every ${summary.provider} account is almost out.`
              : `${summary.provider} is almost out.`}
          </Callout>
        ) : null}
        {[...accounts].sort(byHeadroom).map((account, index) => (
          <Stack gap="md">
            {index > 0 ? <Separator /> : null}
            <AccountView account={account} />
          </Stack>
        ))}
      </Stack>
    </Collapsible>
  )
}

function KeysView() {
  return (
    <Collapsible title="Keys" description="Stored in Orca's encrypted plugin secrets">
      <Stack gap="sm">
        <Text size="xs" muted>
          Keys pi and omp already have are found on their own. Add one here only for an account they do not
          use. Leave a field empty and save to remove its key.
        </Text>
        {KEY_FIELDS.map((field) => (
          <Row gap="sm" align="end">
            <Input
              label={field.label}
              type="password"
              placeholder={field.placeholder}
              value={read(drafts)[field.key] ?? ''}
              onChange={(value) => set(drafts, { ...read(drafts), [field.key]: value })}
              onSubmit={() => saveKey(field.key, field.label)}
            />
            <Button size="sm" onPress={() => saveKey(field.key, field.label)}>
              Save
            </Button>
          </Row>
        ))}
        {read(saved) ? (
          <Text size="xs" tone="success">
            {read(saved)}
          </Text>
        ) : null}
      </Stack>
    </Collapsible>
  )
}

export function QuotaView() {
  const current = read(snapshot)
  const error = read(failure)
  const summaries = current ? summarize(current) : []
  return (
    <Stack gap="md">
      <Row justify="between">
        <Text size="sm" muted>
          Plan limits and credits left
        </Text>
        <Row gap="xs">
          {current ? (
            <Text size="xs" muted>
              <RelativeTime at={current.updatedAt} format="short" />
            </Text>
          ) : null}
          <IconButton
            icon="refresh"
            label="Refresh quotas"
            disabled={read(loading)}
            onPress={() => loadQuota(true)}
          />
        </Row>
      </Row>
      {error ? (
        <Callout tone="danger" title="Refresh failed">
          {error}
        </Callout>
      ) : null}
      {!current ? <Skeleton lines={4} label="Reading quotas" /> : null}
      {current && summaries.length === 0 ? (
        <EmptyState
          icon="gauge"
          title="No accounts found"
          description="Sign in to Claude Code, Codex, Grok or GitHub, or add a key below."
        />
      ) : null}
      {summaries.map((summary) => (
        <ProviderView
          summary={summary}
          accounts={current!.accounts.filter((account) => account.provider === summary.provider)}
        />
      ))}
      {current && current.notes.length > 0 ? (
        <Text size="xs" muted>
          {current.notes.join(' · ')}
        </Text>
      ) : null}
      <KeysView />
    </Stack>
  )
}
