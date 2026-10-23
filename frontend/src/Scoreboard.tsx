import type { TeamName } from './api'

/** One scoreboard line. `team` must use the same naming as `myTeam` (server or in-game view). */
export interface ScoreRow {
  id: string
  name: string
  team: TeamName
  kills: number
  deaths: number
  captures: number
}

const order = (a: ScoreRow, b: ScoreRow) => b.captures - a.captures || b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name)

function Side({ title, rows, meId, tone }: { title: string; rows: ScoreRow[]; meId: string; tone: 'ally' | 'foe' }) {
  const head = tone === 'ally' ? 'text-ally' : 'text-foe'
  return (
    <table className="w-full table-fixed text-left text-sm tabular-nums">
      <caption className={`pb-1.5 text-left font-display text-xs font-bold tracking-[0.2em] uppercase ${head}`}>{title}</caption>
      <thead>
        <tr className="font-display text-[10px] tracking-widest text-ink-400 uppercase">
          <th scope="col" className="py-1 font-semibold">
            Player
          </th>
          <th scope="col" className="w-12 py-1 text-right font-semibold" title="Flag captures">
            Cap
          </th>
          <th scope="col" className="w-10 py-1 text-right font-semibold">
            K
          </th>
          <th scope="col" className="w-10 py-1 text-right font-semibold">
            D
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className={`border-t border-white/[0.06] ${r.id === meId ? 'bg-gold/[0.09] font-semibold text-gold-soft' : 'text-ink-100'}`}>
            <td className="truncate py-1.5 pr-2">{r.name}</td>
            <td className="py-1.5 text-right">{r.captures}</td>
            <td className="py-1.5 text-right">{r.kills}</td>
            <td className="py-1.5 text-right">{r.deaths}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Post-match table: your team on the left, opponents on the right, best performer first. */
export function Scoreboard({ rows, meId, myTeam }: { rows: ScoreRow[]; meId: string; myTeam: TeamName }) {
  const mine = rows.filter((r) => r.team === myTeam).sort(order)
  const theirs = rows.filter((r) => r.team !== myTeam).sort(order)
  return (
    <div className="grid w-full gap-x-8 gap-y-4 sm:grid-cols-2" role="group" aria-label="Scoreboard">
      <Side title="Your team" rows={mine} meId={meId} tone="ally" />
      <Side title="Opponents" rows={theirs} meId={meId} tone="foe" />
    </div>
  )
}
