// Writes docs/METRICS.md from the metric definitions in the code, so the document and
// `lifecycle metrics show` can never drift apart. Runs after tsc.
import { writeFileSync } from 'node:fs'
import { ALL_METRICS, PACKS } from '../dist/metrics.js'

const packsOf = (name) => Object.entries(PACKS).filter(([, names]) => names.includes(name)).map(([p]) => p)
const lines = [
  '# Metric definitions',
  '',
  'One definition per metric. Every built-in metric runs the same SQL every time, and every result carries that SQL and a trust line saying whether the sources it rests on agree. This file is written from the code by `scripts/write-metrics-doc.mjs`; `lifecycle metrics show <name>` prints the same definition with its exact SQL.',
  '',
  `${ALL_METRICS.length} built-in metrics. Numbers you save yourself (\`lifecycle metrics save\`) are marked as yours and are not reviewed.`,
  '',
  '| Metric | What it measures | Unit | Needs | Packs |',
  '|---|---|---|---|---|',
  ...ALL_METRICS.map((m) => `| \`${m.name}\` | ${m.title}. ${m.description.replace(/\|/g, '/')} | ${m.unit} | ${m.needs.join(', ')} | ${packsOf(m.name).join(', ') || 'all'} |`),
  '',
  '## Assumptions stated with each metric',
  '',
  ...ALL_METRICS.filter((m) => m.notes?.length).flatMap((m) => [`- \`${m.name}\`: ${m.notes.join(' ')}`]),
  '',
  '## Contribution margin inputs',
  '',
  'The margin metrics (`cogs`, `gross_margin`, `contribution_margin_before_ads`, `contribution_margin`, `contribution_margin_percent`, `cost_coverage`) read Shopify unit costs where a product has one (`lifecycle costs sync`) and the owner\'s rates in costs.json for the rest (`lifecycle costs set cogs percent:35`). A result lists what went in, what was missing and what was counted as zero, so an assumed cost is always visible.',
  '',
]
writeFileSync('docs/METRICS.md', lines.join('\n'))
console.log('docs/METRICS.md written')
