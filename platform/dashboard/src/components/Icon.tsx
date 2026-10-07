/** A small, consistent line-icon set (24px grid, 1.8 stroke) so every nav item and action is recognisable at a glance. */
const P: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  bus: 'M5 17V6a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v11M5 17h14M5 17v2m14-2v2M5 11h14M8 14h.01M16 14h.01',
  inbox: 'M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z',
  megaphone: 'M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zm12-3a5 5 0 0 1 0 8m2.5-10.5a8.5 8.5 0 0 1 0 13',
  headset: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15a2 2 0 0 0 2 2h1v-5H6a2 2 0 0 0-2 2zm16 0a2 2 0 0 1-2 2h-1v-5h1a2 2 0 0 1 2 2zm-3 2v1a3 3 0 0 1-3 3h-2',
  book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zm0 16V5',
  spark: 'M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  chart: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
  plus: 'M12 5v14M5 12h14',
  rules: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  grid: 'M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z',
  users: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8m13 9v-1a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8',
  apps: 'M4 6a2 2 0 0 1 2-2h3v5H4zm11-2h3a2 2 0 0 1 2 2v3h-5zM4 15h5v5H6a2 2 0 0 1-2-2zm11 0h5v3a2 2 0 0 1-2 2h-3z',
  log: 'M8 4h11a1 1 0 0 1 1 1v15H6a2 2 0 0 1-2-2V4h4zm0 0v16M11 9h6m-6 4h6',
  code: 'm8 9-4 3 4 3m8-6 4 3-4 3M14 5l-4 14',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zm4 4a2 2 0 0 0 4 0',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14m10 3-5-5',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M12 1v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M1 12h2m18 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8',
  auto: 'M12 21a9 9 0 1 0 0-18v18',
  menu: 'M4 6h16M4 12h16M4 18h16',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0',
  sos: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zm0-14v4m0 4h.01',
  ticket: 'M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4zm10-2v12',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18m0-14v5l3 3',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  stop: 'M6 6h12v12H6z',
  trash: 'M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3',
  play: 'M7 4v16l13-8z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4m12-10a2 2 0 1 0 0-4 2 2 0 0 0 0 4M6 15V9a4 4 0 0 1 4-4h6m-8 14h8a4 4 0 0 0 4-4V9',
  calendar: 'M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14H4zm0 4h16M8 3v4m8-4v4',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  logout: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5m5 5H3',
  key: 'M15 7a4 4 0 1 1-3.7 5.5L4 20H2v-2l1-1h2v-2h2l1.5-1.5A4 4 0 0 1 15 7m1 0h.01',
  dots: 'M12 6h.01M12 12h.01M12 18h.01',
  chevron: 'm9 6 6 6-6 6',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
};

export function Icon({ name, size = 18, className, title }: { name: keyof typeof P | string; size?: number; className?: string; title?: string }) {
  return (
    <svg className={`ic ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={P[name] ?? P.dots} />
    </svg>
  );
}
