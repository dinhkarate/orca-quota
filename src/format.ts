// Number formats the panel and the status bar share.

export function formatTokens(value: number): string {
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K']
  ]
  for (const [size, unit] of units) {
    if (value >= size) {
      const scaled = value / size
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)}${unit}`
    }
  }
  return String(Math.round(value))
}

export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) {
    return '<$0.01'
  }
  return value >= 1000 ? `$${Math.round(value).toLocaleString('en-US')}` : `$${value.toFixed(2)}`
}
