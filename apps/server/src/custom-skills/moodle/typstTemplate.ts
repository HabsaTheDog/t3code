export const STUDY_BUDDY_TEMPLATE_FILE = "study-buddy-template.typ";

export const STUDY_BUDDY_TYPST_TEMPLATE = `// Study Buddy Typst design template.
// UTF-8 source is required; German text with äöü and ß is supported.

#let sb-colors = (
  ink: rgb("#1f2937"),
  muted: rgb("#5f6b7a"),
  line: rgb("#d7dde6"),
  panel: rgb("#f7f9fc"),
  blue: rgb("#205493"),
  green: rgb("#27704a"),
  amber: rgb("#a15c00"),
  red: rgb("#a83b3b"),
)

#set page(
  paper: "a4",
  margin: (left: 18mm, right: 18mm, top: 16mm, bottom: 18mm),
  footer: align(center)[
    #text(8pt, fill: sb-colors.muted)[Study Buddy · Seite #context counter(page).display()]
  ],
)
#set text(
  font: "New Computer Modern",
  size: 10.5pt,
  lang: "de",
  region: "AT",
  fill: sb-colors.ink,
)
#set par(justify: true, leading: 0.62em)
#set heading(numbering: "1.1")
#show heading.where(level: 1): it => [
  #v(0.65em)
  #text(17pt, weight: "bold", fill: sb-colors.blue)[#it.body]
  #v(0.18em)
  #line(length: 100%, stroke: 0.7pt + sb-colors.line)
  #v(0.35em)
]
#show heading.where(level: 2): it => [
  #v(0.45em)
  #text(13pt, weight: "bold", fill: sb-colors.ink)[#it.body]
]
#show heading.where(level: 3): it => [
  #v(0.35em)
  #text(11pt, weight: "bold", fill: sb-colors.muted)[#it.body]
]
#show raw: set text(size: 8.5pt)
#show math.equation: set text(fill: sb-colors.ink)

#let sb-chip(label, tone: "blue") = {
  let fill = if tone == "green" {
    rgb("#e8f3ec")
  } else if tone == "amber" {
    rgb("#fff3df")
  } else if tone == "red" {
    rgb("#fdecec")
  } else {
    rgb("#eaf1fb")
  }
  let stroke-color = if tone == "green" {
    sb-colors.green
  } else if tone == "amber" {
    sb-colors.amber
  } else if tone == "red" {
    sb-colors.red
  } else {
    sb-colors.blue
  }
  box(
    fill: fill,
    stroke: 0.45pt + stroke-color,
    radius: 2.5pt,
    inset: (x: 4.2pt, y: 2.1pt),
  )[#text(8.2pt, weight: "medium", fill: stroke-color)[#label]]
}

#let sb-card(title: none, tone: "blue", body) = {
  let stroke-color = if tone == "green" {
    sb-colors.green
  } else if tone == "amber" {
    sb-colors.amber
  } else if tone == "red" {
    sb-colors.red
  } else {
    sb-colors.blue
  }
  block(
    width: 100%,
    fill: sb-colors.panel,
    stroke: (left: 2.2pt + stroke-color, rest: 0.45pt + sb-colors.line),
    radius: 3pt,
    inset: 7pt,
    breakable: true,
  )[
    #if title != none [
      #text(9.6pt, weight: "bold", fill: stroke-color)[#title]
      #v(2.5pt)
    ]
    #body
  ]
}

#let sb-source-note(body) = block(
  width: 100%,
  fill: rgb("#fbfcfe"),
  stroke: 0.4pt + sb-colors.line,
  radius: 2.5pt,
  inset: 5pt,
  breakable: true,
)[#text(8.4pt, fill: sb-colors.muted)[#body]]

#let sb-formula(name: none, variables: (), units: (), source: none, body) = sb-card(
  title: if name == none { "Formel" } else { name },
  tone: "green",
)[
  #align(center)[#text(12pt)[#body]]
  #if variables.len() > 0 [
    #v(3pt)
    #text(8.5pt, fill: sb-colors.muted)[Variablen: #variables.join(", ")]
  ]
  #if units.len() > 0 [
    #linebreak()
    #text(8.5pt, fill: sb-colors.muted)[Einheiten: #units.join(", ")]
  ]
  #if source != none [
    #linebreak()
    #text(8.2pt, fill: sb-colors.muted)[Quelle: #source]
  ]
]

#let sb-example(title: "Beispiel", body) = sb-card(title: title, tone: "amber")[#body]

#let sb-diagram(caption: none, body) = [
  #block(
    width: 100%,
    fill: rgb("#ffffff"),
    stroke: 0.55pt + sb-colors.line,
    radius: 3pt,
    inset: 7pt,
    breakable: true,
  )[
    #align(center)[#body]
  ]
  #if caption != none [
    #v(2pt)
    #align(center)[#text(8.2pt, fill: sb-colors.muted)[#caption]]
  ]
]

#let sb-key-table(columns, rows) = table(
  columns: columns,
  stroke: 0.35pt + sb-colors.line,
  inset: 4pt,
  align: horizon,
  table.header(..rows.first()),
  ..rows.slice(1).flatten(),
)

#let sb-document(
  title: "Study Buddy",
  subtitle: none,
  course: none,
  kind: "Lernzettel",
  body: [],
) = [
  #set document(title: title, author: "Study Buddy")
  #block(width: 100%, inset: (bottom: 4mm))[
    #text(22pt, weight: "bold", fill: sb-colors.ink)[#title]
    #if subtitle != none [
      #linebreak()
      #text(10pt, fill: sb-colors.muted)[#subtitle]
    ]
    #v(3pt)
    #if course != none [#sb-chip(course) #h(4pt)]
    #sb-chip(kind, tone: "green")
  ]
  #body
]
`;

export function studyBuddyTemplatePromptReference(): string {
  return [
    "Use the Study Buddy Typst design template exactly as the document shell.",
    `The run directory will contain ${STUDY_BUDDY_TEMPLATE_FILE}; import it with:`,
    `#import "${STUDY_BUDDY_TEMPLATE_FILE}": *`,
    "Wrap the content in #sb-document(title: ..., subtitle: ..., course: ..., kind: ..., body: [ ... ]).",
    "Use A4 only. Use German/Austrian conventions: decimal comma in prose where appropriate, SI units, dates as TT.MM.JJJJ, 24-hour time, and European paper/layout assumptions.",
    "The Typst source must be UTF-8 and may contain German Umlaute directly: ä, ö, ü, Ä, Ö, Ü, ß.",
    "Use template helpers for structure: #sb-card, #sb-formula, #sb-example, #sb-diagram, #sb-source-note, and #sb-key-table.",
    "Render formulas with Typst math, not screenshots. Use readable variable lists and SI units for every important equation.",
    "For diagrams, prefer clean Typst-native tables/grids/boxes inside #sb-diagram. If the exact geometry is uncertain, draw a clear conceptual diagram and label all axes, forces, nodes, states, or signal paths.",
    "Keep source references visible near claims and formulas. Never invent a source id.",
    "Return only Typst source, no Markdown fences, no explanation.",
  ].join("\n");
}

export function typstPdfPath(typstPath: string): string {
  return typstPath.replace(/\.typ$/i, ".pdf");
}
