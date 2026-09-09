"""Build the original vector terrain and embed it in the standalone demo.

Run from any directory: python3 docs/marketing/build_visual.py
The terrain is a conceptual search landscape, not a measured score surface.
"""
from pathlib import Path
from math import exp, sin, pi
from html import escape

ROOT = Path(__file__).resolve().parent
index = ROOT / 'index.html'
html = index.read_text(encoding='utf-8')
start = '<!-- illustration:start -->'
end = '<!-- illustration:end -->'
if html.count(start) != 1 or html.count(end) != 1:
    raise SystemExit('index.html must contain one illustration:start and illustration:end marker.')
a, b = html.index(start) + len(start), html.index(end)
if a > b:
    raise SystemExit('index.html illustration:start must precede illustration:end.')


def height(u, v):
    return (.09 + 1.05 * exp(-((u-.78)**2/.045 + (v-.27)**2/.045))
            + .38 * exp(-((u-.37)**2/.033 + (v-.55)**2/.055))
            + .20 * exp(-((u-.77)**2/.026 + (v-.84)**2/.025))
            + .014 * sin(u*26 + v*8) * sin(v*19) * sin(u*pi) * sin(v*pi))


def project(u, v, z=None):
    z = height(u, v) if z is None else z
    return 810+(u-v)*690, 400+(u+v)*210-z*270


def path(points, close=False):
    return 'M' + 'L'.join(f'{x:.1f} {y:.1f}' for x,y in points) + ('Z' if close else '')


def text(x, y, value, size=16, fill='#9aaab5', extra=''):
    return f'<text x="{x}" y="{y}" font-size="{size}" fill="{fill}" {extra}>{escape(value)}</text>'


def smooth_route(uvs):
    points = []
    extended = [uvs[0], *uvs, uvs[-1]]
    for i in range(1, len(extended)-2):
        a,b,c,d = extended[i-1:i+3]
        for n in range(20):
            t=n/20
            pair=[]
            for axis in range(2):
                pair.append(.5*((2*b[axis])+(-a[axis]+c[axis])*t
                    +(2*a[axis]-5*b[axis]+4*c[axis]-d[axis])*t*t
                    +(-a[axis]+3*b[axis]-3*c[axis]+d[axis])*t*t*t))
            x,y=project(*pair)
            points.append((x,y-6))
    x,y=project(*uvs[-1])
    points.append((x,y-6))
    return path(points)


svg = ['''<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1040" viewBox="0 0 1600 1040" role="img" aria-labelledby="title desc">
<title id="title">Give your agent something to climb.</title>
<desc id="desc">An original illustrated search landscape with a luminous route between evaluated software revisions. Accepted scores progress from 54 to 68 to 82 to 91. An orange branch marks a candidate rejected for a critical regression despite a score of 77. An unverified candidate sits outside the terrain and has no score. The landscape is conceptual and every result is illustrative. The external coding agent edits and selects; Agent Eval Kit evaluates, compares, and returns evidence.</desc>
<defs>
  <radialGradient id="ambient"><stop stop-color="#1c413e" stop-opacity=".42"/><stop offset="1" stop-color="#0b121c" stop-opacity="0"/></radialGradient>
  <radialGradient id="summit-light"><stop stop-color="#bff4af" stop-opacity=".17"/><stop offset="1" stop-color="#a9e4c0" stop-opacity="0"/></radialGradient>
  <linearGradient id="strata" x2="0" y2="1"><stop stop-color="#223a41"/><stop offset="1" stop-color="#0b121c"/></linearGradient>
  <linearGradient id="route-color"><stop stop-color="#84c5b9"/><stop offset=".55" stop-color="#b4f3b9"/><stop offset="1" stop-color="#e7fac0"/></linearGradient>
  <linearGradient id="card-bg" x2="1" y2="1"><stop stop-color="#192631"/><stop offset="1" stop-color="#101923"/></linearGradient>
  <filter id="route-glow" x="-50%" y="-100%" width="200%" height="300%"><feGaussianBlur stdDeviation="6"/></filter>
  <filter id="soft-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="18"/></filter>
  <pattern id="stars" width="38" height="38" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".65" fill="#a7bac9" opacity=".17"/></pattern>
  <style>
    text { font-family:Arial,Helvetica,sans-serif; }
    .mono { font-family:'Courier New',monospace; letter-spacing:1.5px; }
    .chart .export-only { display:none; }
    .compact-label, .pending-label { display:none; }
    .point { cursor:pointer; outline:none; }
    .halo { fill:transparent; stroke:transparent; }
    .point:focus .halo { stroke:#f2f6e9; stroke-width:2; }
    .point[aria-pressed="true"] .halo { stroke:var(--point-color,#c9f5b7); stroke-width:2; fill:#b8f9cd10; }
    .point[aria-pressed="true"] .node-card { stroke:var(--point-color,#acdcab); }
  </style>
</defs>
<path fill="#0b121c" d="M0 0h1600v1040H0z"/>
<ellipse cx="950" cy="495" rx="700" ry="430" fill="url(#ambient)"/>
<path fill="url(#stars)" d="M50 265h1500v540H50z"/>
<g fill="none" stroke="#283542" stroke-width="1"><path d="M70 275v-10h10m1440 0h10v10M70 795v10h10m1440 0h10v-10"/></g>
<rect x="70" y="43" width="32" height="32" rx="9" fill="#b8edb0"/>
<path d="m77 65 6-9 5 4 7-10" fill="none" stroke="#11201c" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
''']
svg += [text(115,66,'agent eval kit',22,'#eef1e8','font-weight="700"'),
        text(1530,65,'THE EVALUATION LAYER FOR AUTONOMOUS IMPROVEMENT',12,'#94a4b3','class="mono" text-anchor="end"'),
        text(70,163,'Give your agent',78,'#edf0e7','font-weight="600" letter-spacing="-4"'),
        text(70,245,'something to climb.',78,'#edf0e7','class="export-only" font-weight="600" letter-spacing="-4"'),
        text(1070,151,'Your agent makes the next move.',21,'#d3dedb'),
        text(1070,184,'AEK measures what changed.',21,'#b8edb0'),
        text(1070,221,'Evidence. Comparison. Another step forward.',15,'#94a4b3'),
        text(95,305,'01 / THE SEARCH SPACE',12,'#8195a5','class="mono"'),
        text(1505,282,'ILLUSTRATIVE LANDSCAPE · NOT A SCORE AXIS',11,'#8195a5','class="mono" text-anchor="end"')]

# A floating, stratified terrain gives the metaphor a tangible silhouette.
outline=[project(0,0,0),project(1,0,0),project(1,1,0),project(0,1,0)]
svg.append(f'<path d="{path(outline,True)}" fill="#101c27" stroke="#2c4350"/>')
for edge in [([(i/60,1) for i in range(61)]), ([(1,i/60) for i in range(61)])]:
    top=[project(u,v) for u,v in edge]
    bottom=[(project(u,v,0)[0],project(u,v,0)[1]+19) for u,v in reversed(edge)]
    svg.append(f'<path d="{path(top+bottom,True)}" fill="url(#strata)" stroke="#29404a" stroke-width=".8"/>')
for level in [4,10,16]:
    line=[(project(u,v,0)[0],project(u,v,0)[1]+level) for u,v in [(0,1),(1,1),(1,0)]]
    svg.append(f'<path d="{path(line)}" fill="none" stroke="#44616b" stroke-opacity=".25"/>')

# Original procedural surface; no third-party artwork or textures.
steps=54
cells=[]
for i in range(steps):
    for j in range(steps):
        u,v=(i+.5)/steps,(j+.5)/steps
        z=height(u,v)
        du=(height(u+.005,v)-height(u-.005,v))/.01
        dv=(height(u,v+.005)-height(u,v-.005))/.01
        light=max(0,min(1,.40-.095*du-.04*dv+z*.33))
        rgb=(int(14+light*38),int(29+light*56),int(40+light*40))
        pts=[project(i/steps,j/steps),project((i+1)/steps,j/steps),project((i+1)/steps,(j+1)/steps),project(i/steps,(j+1)/steps)]
        cells.append((u+v,f'<path d="{path(pts,True)}" fill="rgb{rgb}" stroke="rgb{rgb}" stroke-width=".45"/>'))
svg.extend(item for _,item in sorted(cells))
for direction in [0,1]:
    for i in range(65):
        pts=[]
        for j in range(101):
            u,v=(i/64,j/100) if direction==0 else (j/100,i/64)
            pts.append(project(u,v))
        opacity=.22 if direction==0 else .35
        svg.append(f'<path d="{path(pts)}" fill="none" stroke="#8dc6be" stroke-width=".7" stroke-opacity="{opacity}"/>')
svg.append('<ellipse cx="1162" cy="315" rx="240" ry="170" fill="url(#summit-light)"/>')

uvs={0:(.08,.78),1:(.29,.61),2:(.29,.38),3:(.63,.40),5:(.78,.27)}
routes=[(1,[uvs[0],(.16,.72),(.23,.71),uvs[1]]),
        (3,[uvs[1],(.37,.64),(.45,.58),(.52,.50),uvs[3]]),
        (5,[uvs[3],(.69,.37),(.70,.29),uvs[5]])]
for step,uv in routes:
    d=smooth_route(uv)
    svg.append(f'<g class="route" data-route="{step}"><path d="{d}" fill="none" stroke="#b8f9a8" stroke-width="14" opacity=".4" filter="url(#route-glow)"/><path class="trail" d="{d}" fill="none" stroke="url(#route-color)" stroke-width="3.5" stroke-linecap="round"/></g>')
rejected=smooth_route([uvs[1],(.26,.52),uvs[2]])
svg.append(f'<path class="branch" data-branch="2" d="{rejected}" fill="none" stroke="#e8a17f" stroke-width="2" stroke-dasharray="5 7"/>')

# Unverified evidence belongs outside the search surface, without a numeric height.
svg.append('<path data-branch="4" d="M990 457C1100 535 1190 579 1325 621" fill="none" stroke="#8e9dbb" stroke-opacity=".55" stroke-width="1.4" stroke-dasharray="3 7"/>')

# Labeled checkpoints keep a rich illustration readable without a legend lookup.
labels={0:(166,603,175,'00 / BASELINE','54','Starting point'),
        1:(403,369,183,'01 / ACCEPTED','68','Keep the gain'),
        2:(695,532,241,'02 / REJECTED','77','Critical check failed'),
        3:(837,344,191,'03 / ACCEPTED','82','Gates passing'),
        5:(1233,335,264,'05 / NEW BEST','91','Target 85 exceeded')}
for step in [0,1,2,3,4,5]:
    if step==4:
        svg += ['<g class="point" data-step="4" style="--point-color:#bbb9dc">',
            '<circle class="halo" cx="1332" cy="650" r="25"/>',
            '<g class="evidence-card"><rect class="node-card" x="1263" y="617" width="241" height="110" rx="12" fill="url(#card-bg)" stroke="#4c526b"/>',
            '<circle cx="1286" cy="640" r="5" fill="none" stroke="#b4b6d7" stroke-dasharray="2 2"/>',
            text(1301,644,'04 / UNVERIFIED',11,'#babbd7','class="mono"'),
            text(1284,682,'—',29,'#dde0ee'),text(1325,679,'Score withheld',16,'#dde0ee'),
            text(1284,707,'58% coverage. Get more evidence.',12,'#9caac0'),'</g>',
            text(1332,650,'…',30,'#bbb9dc','class="pending-label"'),
            text(1310,660,'—',52,'#d4d4ee','class="compact-label" paint-order="stroke" stroke="#0b121c" stroke-width="8"'),'</g>']
        continue
    x,y=project(*uvs[step]); y-=6
    lx,ly,w,kicker,score,caption=labels[step]
    color='#e8a17f' if step==2 else '#c9efbd'
    svg.append(f'<g class="point" data-step="{step}" style="--point-color:{color}">')
    # A hairline attaches each evidence label to the surface.
    attach_x=max(lx+15,min(lx+w-15,x))
    attach_y=ly+90 if ly<y else ly
    svg.append(f'<path class="card-leader" d="M{x:.1f} {y:.1f}L{attach_x:.1f} {attach_y}" stroke="{color}" stroke-opacity=".55" fill="none"/>')
    svg.append(f'<ellipse cx="{x:.1f}" cy="{y+7:.1f}" rx="16" ry="6" fill="#080e16" opacity=".8"/>')
    svg.append(f'<circle class="halo" cx="{x:.1f}" cy="{y:.1f}" r="24"/>')
    svg.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="8" fill="#0b121c" stroke="{color}" stroke-width="2.5"/>')
    if step==2:
        svg.append(f'<path d="m{x-3:.1f} {y-3:.1f} 6 6m0-6-6 6" stroke="{color}" stroke-width="1.5"/>')
    else:
        svg.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3" fill="{color}"/>')
    if step==5:
        svg.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="17" fill="none" stroke="{color}" stroke-opacity=".4"/>')
        svg.append(f'<path d="M{x:.1f} {y-17:.1f}v-36" stroke="{color}" stroke-opacity=".6"/><path d="m{x:.1f} {y-53:.1f} 23 5-23 6" fill="{color}"/>')
    svg += [f'<g class="evidence-card"><rect class="node-card" x="{lx}" y="{ly}" width="{w}" height="90" rx="10" fill="url(#card-bg)" stroke="#33434e"/>',
            text(lx+16,ly+24,kicker,11,color,'class="mono"'),
            text(lx+16,ly+63,score,32,'#eef2e8','font-weight="500"'),
            text(lx+61,ly+61,caption,14,'#bac8d0'),'</g>',
            text(x+20,y-14,'…',30,'#c2d1db','class="pending-label"'),
            text(x+16,y-22,score,48,color,'class="compact-label" paint-order="stroke" stroke="#0b121c" stroke-width="8"'),'</g>']
svg += [text(95,766,'A DIRECTION YOUR AGENT CAN ACT ON.',11,'#7e94a4','class="mono"'),
        '<circle cx="99" cy="790" r="3" fill="#bce9b2"/>',text(111,794,'Accepted revision',12),
        '<circle cx="272" cy="790" r="3" fill="#e8a17f"/>',text(284,794,'Rejected candidate',12),
        '<circle cx="457" cy="790" r="3" fill="none" stroke="#abaecd"/>',text(469,794,'Insufficient evidence',12),
        text(1505,794,'SYNTHETIC SCORES / SAME RUBRIC',11,'#7e94a4','class="mono" text-anchor="end"')]
svg += ['<path d="M70 840H1530" stroke="#293642"/>',
        text(70,875,'02 / THE FEEDBACK LOOP',11,'#8195a5','class="mono"'),
        '<rect x="70" y="895" width="328" height="78" rx="12" fill="#131e29" stroke="#2b3946"/>',
        text(92,923,'YOUR CODING AGENT',11,'#99aab9','class="mono"'),text(92,952,'Make a change',22,'#eef2e8'),
        text(420,943,'→',28,'#9bb3ad'),
        '<rect x="470" y="895" width="648" height="78" rx="12" fill="#172f2b" stroke="#53775d"/>',
        text(493,923,'AGENT EVAL KIT',11,'#c9efbd','class="mono"'),text(493,952,'Evaluate → Compare → Return evidence',22,'#edf4e8'),
        text(1142,943,'→',28,'#9bb3ad'),
        '<rect x="1191" y="895" width="339" height="78" rx="12" fill="#131e29" stroke="#2b3946"/>',
        text(1213,923,'YOUR CODING AGENT',11,'#99aab9','class="mono"'),text(1213,952,'Keep or revise. Repeat.',22,'#eef2e8'),
        text(70,1012,'Define what better means. Feed the evidence into the next move.',14,'#94a4b3'),
        text(1530,1012,'ILLUSTRATIVE RESULTS · EXTERNAL AGENT OWNS EDITING AND SELECTION',10,'#8195a5','class="mono" text-anchor="end"'),'</svg>']
full='\n'.join(svg)+'\n'
chart=full.replace('width="1600" height="1040" viewBox="0 0 1600 1040" role="img"', 'class="chart" width="1600" height="595" viewBox="0 245 1600 595" role="group"')
(ROOT/'hill-climbing.svg').write_text(full, encoding='utf-8')
index.write_text(html[:a]+'\n'+chart+html[b:], encoding='utf-8')
print('Built hill-climbing.svg and embedded the same illustration in index.html.')
