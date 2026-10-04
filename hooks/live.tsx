import type { ElementTable } from 'claude-code'

// The live view: the pinned tab, drawn in the terminal as a picture (kitty graphics, so
// Ghostty or kitty; its alt text elsewhere). /browser view opens it as a pane; while it is
// open a frame is grabbed every couple of seconds and after every browser call, and swapped
// in with $.ui.blit, so no render pass runs per frame. Frames alternate between two files so
// the terminal never reads one mid-write. register.tsx drives it; this holds its state and
// draws it.

export const VIEW_PANE = 'browser-view'
export const FRAME_KEY = 'frame'
export const FRAME_EVERY_MS = 2000
// A Ghostty cell is roughly twice as tall as it is wide.
const CELL_ASPECT = 2.1

export const live = {
  open: false,
  timer: undefined as { cancel(): void } | undefined,
  grabbing: false,
  generation: 0,
  file: undefined as string | undefined,
  // The viewport's shape, so the picture keeps its aspect: CSS height over width.
  aspect: 0.625,
  address: undefined as string | undefined,
  connected: false,
}

export function stopView(): void {
  live.open = false
  live.timer?.cancel()
  live.timer = undefined
}

/** The next frame's file: the one the terminal is not showing. */
export function nextFrameFile(artifactDir: string): string {
  return `${artifactDir}/live-${live.generation % 2}.png`
}

/** Reads `[innerWidth, innerHeight]` from an eval's output into the aspect. */
export function takeViewport(output: string): void {
  const match = output.match(/\[(\d+),\s*(\d+)\]/)
  if (match && Number(match[1]) > 0) live.aspect = Number(match[2]) / Number(match[1])
}

/** The largest box of cells that keeps the page's aspect inside the pane's body. */
export function frameBox(bodyColumns: number, bodyRows: number, aspect = live.aspect): { columns: number; rows: number } {
  const maxColumns = Math.min(255, Math.max(10, bodyColumns))
  const maxRows = Math.min(255, Math.max(4, bodyRows))
  let columns = maxColumns
  let rows = Math.max(1, Math.round((columns * aspect) / CELL_ASPECT))
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.min(maxColumns, Math.round((rows * CELL_ASPECT) / aspect)))
  }
  return { columns, rows }
}

export function renderView(ui: ElementTable, surface: string, props: { bodyColumns?: number; scroll?: { bodyRows?: number } }) {
  const { Box, Text } = ui
  const header = (
    <Text dimColor>
      {live.address ?? 'no page'}
      {live.connected ? '' : '  disconnected'}
    </Text>
  )
  if (surface !== 'terminal' || !live.file || !('Image' in ui)) {
    return (
      <Box flexDirection="column">
        {header}
        <Text dimColor>{live.file ? 'The live view draws in a terminal with kitty graphics.' : 'Waiting for the first frame.'}</Text>
      </Box>
    )
  }
  const { Image } = ui as ElementTable<'terminal'>
  // One row for the address above the picture.
  const { columns, rows } = frameBox(props.bodyColumns ?? 80, (props.scroll?.bodyRows ?? 40) - 1)
  return (
    <Box flexDirection="column">
      {header}
      <Image
        key={FRAME_KEY}
        source={{ file: live.file, format: 'png', generation: live.generation }}
        columns={columns}
        rows={rows}
        alt={`Browser: ${live.address ?? 'page'}`}
      />
    </Box>
  )
}
