import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import opentype from 'opentype.js'
import paper from 'paper'
import JSZip from 'jszip'
import { saveAs } from 'file-saver'
import './App.css'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const CANVAS_WIDTH = 1100
const CANVAS_HEIGHT = 460

const PRELOADED_FONTS = [
  { name: 'Inter', url: 'https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-400-normal.ttf' },
  { name: 'Roboto', url: 'https://cdn.jsdelivr.net/fontsource/fonts/roboto@latest/latin-400-normal.ttf' },
  { name: 'Open Sans', url: 'https://cdn.jsdelivr.net/fontsource/fonts/open-sans@latest/latin-400-normal.ttf' },
  { name: 'Montserrat', url: 'https://cdn.jsdelivr.net/fontsource/fonts/montserrat@latest/latin-400-normal.ttf' },
  { name: 'Lato', url: 'https://cdn.jsdelivr.net/fontsource/fonts/lato@latest/latin-400-normal.ttf' },
  { name: 'Poppins', url: 'https://cdn.jsdelivr.net/fontsource/fonts/poppins@latest/latin-400-normal.ttf' },
  { name: 'DM Sans', url: 'https://cdn.jsdelivr.net/fontsource/fonts/dm-sans@latest/latin-400-normal.ttf' },
  { name: 'Work Sans', url: 'https://cdn.jsdelivr.net/fontsource/fonts/work-sans@latest/latin-400-normal.ttf' },
]

const loadFontFromUrl = async (url) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error('Failed to fetch font')
  const buffer = await response.arrayBuffer()
  return opentype.parse(buffer)
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const LOWERCASE_NO_EXT = new Set('acemnorsuvwxz'.split(''))
const LOWERCASE_DESCENDERS = new Set('gjpqy'.split(''))
const LOWERCASE_ASCENDERS = new Set('bdfhklt'.split(''))
const UPPERCASE = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''))

const getFontMetrics = (font, fontSize, baselineY) => {
  const scale = fontSize / font.unitsPerEm
  const os2 = font.tables?.os2
  const xHeight = os2?.sxHeight ? os2.sxHeight * scale : null
  const capHeight = os2?.sCapHeight ? os2.sCapHeight * scale : null
  const ascender = font.ascender * scale
  const descender = font.descender * scale

  return {
    xHeightY: xHeight != null ? baselineY - xHeight : null,
    capHeightY: capHeight != null ? baselineY - capHeight : null,
    ascenderY: baselineY - ascender,
    descenderY: baselineY - descender,
    baselineY,
  }
}

const classifyPairBounds = (leftChar, rightChar, metrics, fallbackTop, fallbackBottom) => {
  const left = leftChar || ''
  const right = rightChar || ''
  const isLeftUpper = UPPERCASE.has(left)
  const isRightUpper = UPPERCASE.has(right)
  const isLeftLowerNoExt = LOWERCASE_NO_EXT.has(left)
  const isRightLowerNoExt = LOWERCASE_NO_EXT.has(right)
  const isLeftDesc = LOWERCASE_DESCENDERS.has(left)
  const isRightDesc = LOWERCASE_DESCENDERS.has(right)
  const isLeftAsc = LOWERCASE_ASCENDERS.has(left)
  const isRightAsc = LOWERCASE_ASCENDERS.has(right)
  const isLeftLower = isLeftLowerNoExt || isLeftDesc || isLeftAsc
  const isRightLower = isRightLowerNoExt || isRightDesc || isRightAsc

  const hasDesc = isLeftDesc || isRightDesc
  const hasAsc = isLeftAsc || isRightAsc
  const hasUpper = isLeftUpper || isRightUpper
  const allLower = isLeftLower && isRightLower

  if (allLower && !hasDesc && !hasAsc) {
    if (metrics.xHeightY != null) {
      return { top: metrics.xHeightY, bottom: metrics.baselineY }
    }
  }

  if (allLower && (hasDesc || hasAsc)) {
    return { top: metrics.ascenderY, bottom: metrics.descenderY }
  }

  if (hasUpper && !hasDesc) {
    if (metrics.capHeightY != null) {
      return { top: metrics.capHeightY, bottom: metrics.baselineY }
    }
  }

  if (hasUpper && hasDesc) {
    const top = metrics.capHeightY != null ? metrics.capHeightY : metrics.ascenderY
    return { top, bottom: metrics.descenderY }
  }

  return { top: fallbackTop, bottom: fallbackBottom }
}

const createPaperScope = (canvas) => {
  const scope = new paper.PaperScope()
  scope.setup(canvas)
  return scope
}

const opentypePathToCompoundPath = (scope, openPath) => {
  const compound = new scope.CompoundPath()
  let currentPath = null

  openPath.commands.forEach((command) => {
    if (command.type === 'M') {
      currentPath = new scope.Path()
      currentPath.add(new scope.Point(command.x, command.y))
      compound.addChild(currentPath)
      return
    }

    if (!currentPath) {
      return
    }

    if (command.type === 'L') {
      currentPath.lineTo(new scope.Point(command.x, command.y))
    } else if (command.type === 'Q') {
      currentPath.quadraticCurveTo(
        new scope.Point(command.x1, command.y1),
        new scope.Point(command.x, command.y),
      )
    } else if (command.type === 'C') {
      currentPath.cubicCurveTo(
        new scope.Point(command.x1, command.y1),
        new scope.Point(command.x2, command.y2),
        new scope.Point(command.x, command.y),
      )
    } else if (command.type === 'Z') {
      currentPath.closePath()
    }
  })

  return compound
}

const buildSvgString = ({ width, height, pathData }) => {
  const safePath = pathData || ''
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">\n  <path d="${safePath}" fill="black"/>\n</svg>`
}

const pickCentralIslandPathData = (resultPath, absoluteMid) => {
  if (!resultPath) {
    return ''
  }

  const children = resultPath.children || []
  if (!children.length) {
    return resultPath.pathData || ''
  }

  const best = children.reduce(
    (closest, child) => {
      if (!child?.bounds) {
        return closest
      }

      const centerX = child.bounds.center.x
      const distance = Math.abs(centerX - absoluteMid)

      if (distance < closest.distance) {
        return { child, distance }
      }

      return closest
    },
    { child: null, distance: Number.POSITIVE_INFINITY },
  )

  return best.child?.pathData || ''
}

const layoutGlyphs = (
  font,
  text,
  fontSize,
  trackingPx,
  manualKerningPx,
  activePairIndex,
  origin = {},
) => {
  const glyphs = font.stringToGlyphs(text)
  const scale = fontSize / font.unitsPerEm
  const positioned = []
  let cursorX = 0
  const startX = origin.startX || 0
  const startY = origin.startY || 0

  for (let index = 0; index < glyphs.length; index += 1) {
    const glyph = glyphs[index]
    positioned.push({ glyph, x: startX + cursorX, y: startY, char: text[index] })

    if (index >= glyphs.length - 1) {
      continue
    }

    const nextGlyph = glyphs[index + 1]
    const advanceWidth = (glyph.advanceWidth || font.unitsPerEm) * scale
    const kerning = (font.getKerningValue(glyph, nextGlyph) || 0) * scale
    const manual = activePairIndex === index ? manualKerningPx : 0

    cursorX += advanceWidth + kerning + trackingPx + manual
  }

  if (glyphs.length > 0) {
    const last = glyphs[glyphs.length - 1]
    cursorX += (last.advanceWidth || font.unitsPerEm) * scale
  }

  return { glyphs: positioned, width: cursorX }
}

const computePairCounterform = ({
  scope,
  leftGlyph,
  rightGlyph,
  leftX,
  rightX,
  baselineY,
  fontSize,
  font,
  leftChar,
  rightChar,
}) => {
  const leftPath = leftGlyph.getPath(leftX, baselineY, fontSize, { kerning: false })
  const rightPath = rightGlyph.getPath(rightX, baselineY, fontSize, { kerning: false })
  const leftBounds = leftPath.getBoundingBox()
  const rightBounds = rightPath.getBoundingBox()

  const bboxLeft = Math.min(leftBounds.x1, rightBounds.x1)
  const bboxRight = Math.max(leftBounds.x2, rightBounds.x2)

  const glyphTop = Math.min(leftBounds.y1, rightBounds.y1)
  const glyphBottom = Math.max(leftBounds.y2, rightBounds.y2)

  let bboxTop = glyphTop
  let bboxBottom = glyphBottom

  if (font && leftChar && rightChar) {
    const metrics = getFontMetrics(font, fontSize, baselineY)
    const classified = classifyPairBounds(leftChar, rightChar, metrics, glyphTop, glyphBottom)
    bboxTop = classified.top
    bboxBottom = classified.bottom
  }

  const bboxWidth = bboxRight - bboxLeft
  const bboxHeight = bboxBottom - bboxTop

  if (bboxWidth <= 0.01 || bboxHeight <= 0.01) {
    return ''
  }

  const trapRect = new scope.Path.Rectangle(
    new scope.Rectangle(bboxLeft, bboxTop, bboxWidth, bboxHeight),
  )

  const leftShape = opentypePathToCompoundPath(scope, leftPath)
  const rightShape = opentypePathToCompoundPath(scope, rightPath)

  const finalPath = trapRect.subtract(leftShape).subtract(rightShape)
  finalPath.fillColor = 'black'
  finalPath.strokeWidth = 0
  const pathData = pickCentralIslandPathData(finalPath, bboxLeft + bboxWidth / 2)

  trapRect.remove()
  leftShape.remove()
  rightShape.remove()
  finalPath.remove()

  return pathData
}

function App() {
  const [font, setFont] = useState(null)
  const [fontName, setFontName] = useState('')
  const [fontLoading, setFontLoading] = useState(false)
  const [text, setText] = useState('Hamburg')
  const [fontSize, setFontSize] = useState(260)
  const [tracking, setTracking] = useState(0)
  const [manualKerning, setManualKerning] = useState(0)
  const [activePairIndex, setActivePairIndex] = useState(0)
  const [extracted, setExtracted] = useState(false)
  const [archiveMode, setArchiveMode] = useState(false)
  const [archivePair, setArchivePair] = useState('AV')
  const [archiveData, setArchiveData] = useState({})
  const [archiveLivePath, setArchiveLivePath] = useState('')
  const [archiveProgress, setArchiveProgress] = useState(0)
  const [archiveReady, setArchiveReady] = useState(false)
  const [isGeneratingArchive, setIsGeneratingArchive] = useState(false)
  const [extractedCounterforms, setExtractedCounterforms] = useState([])
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [error, setError] = useState('')
  const [viewportSize, setViewportSize] = useState({ width: CANVAS_WIDTH, height: CANVAS_HEIGHT })
  const [systemPanelOpen, setSystemPanelOpen] = useState(false)
  const [canvasEmpty, setCanvasEmpty] = useState(false)
  const [showIntro, setShowIntro] = useState(true)

  const canvasRef = useRef(null)
  const workspaceRef = useRef(null)
  const scopeRef = useRef(null)
  const toolRef = useRef(null)
  const activeItemRef = useRef(null)
  const activeSegmentRef = useRef(null)
  const interactiveItemsRef = useRef([])
  const undoStackRef = useRef([])
  const redoStackRef = useRef([])
  const interactionStartSnapshotRef = useRef(null)
  const archiveRunRef = useRef(0)
  const panModeRef = useRef(false)

  const captureProjectSnapshot = useCallback(() => {
    const scope = scopeRef.current
    if (!scope) {
      return ''
    }
    return scope.project.exportJSON({ asString: true, precision: 4 })
  }, [])

  const snapshotKey = useCallback((snapshot) => snapshot || '', [])

  const refreshInteractiveItems = useCallback(() => {
    const scope = scopeRef.current
    if (!scope) {
      return
    }

    interactiveItemsRef.current = scope.project.getItems({
      match: (item) => Boolean(item?.data?.interactive),
    })

    activeItemRef.current = null
    activeSegmentRef.current = null
  }, [])

  const syncHistoryState = useCallback(() => {
    setCanUndo(undoStackRef.current.length > 0)
    setCanRedo(redoStackRef.current.length > 0)
  }, [])

  const fitToView = useCallback(() => {
    const scope = scopeRef.current
    if (!scope) {
      return
    }

    const view = scope.view
    const bounds = scope.project.activeLayer?.bounds
    if (!bounds || bounds.isEmpty()) {
      return
    }

    const shouldScaleDown = bounds.width > view.size.width || bounds.height > view.size.height
    view.center = bounds.center
    view.zoom = shouldScaleDown
      ? Math.min(view.size.width / bounds.width, view.size.height / bounds.height) * 0.9
      : 1
  }, [])

  const resetView = useCallback(() => {
    const scope = scopeRef.current
    if (!scope) {
      return
    }

    const view = scope.view
    const bounds = scope.project.activeLayer?.bounds
    if (!bounds || bounds.isEmpty()) {
      view.center = new scope.Point(view.viewSize.width / 2, view.viewSize.height / 2)
      view.zoom = 1
      view.update()
      return
    }

    const safeZoom = Math.min(
      view.size.width / Math.max(bounds.width, 1),
      view.size.height / Math.max(bounds.height, 1),
    ) * 0.9

    view.center = bounds.center
    view.zoom = clamp(safeZoom, 0.05, 15)
    view.update()
  }, [])

  const resetHistory = useCallback(() => {
    undoStackRef.current = []
    redoStackRef.current = []
    interactionStartSnapshotRef.current = null
    syncHistoryState()
  }, [syncHistoryState])

  const clearCanvas = useCallback(() => {
    const scope = scopeRef.current
    if (scope?.project) {
      scope.project.clear()
      scope.view.update()
    }

    setFont(null)
    setText('')
    setExtracted(false)
    setArchiveMode(false)
    setArchivePair('')
    setArchiveData({})
    setArchiveLivePath('')
    setArchiveProgress(0)
    setArchiveReady(false)
    setIsGeneratingArchive(false)
    setExtractedCounterforms([])
    setCanvasEmpty(true)
    setError('')

    activeItemRef.current = null
    activeSegmentRef.current = null
    interactiveItemsRef.current = []
    resetHistory()
  }, [resetHistory])

  const restoreProjectSnapshot = useCallback((snapshot) => {
    const scope = scopeRef.current
    if (!scope || !snapshot) {
      return
    }

    scope.project.clear()
    scope.project.importJSON(snapshot)
    refreshInteractiveItems()

    scope.view.update()
  }, [refreshInteractiveItems])

  const pushHistorySnapshot = useCallback((beforeSnapshot, afterSnapshot) => {
    if (!beforeSnapshot || !afterSnapshot) {
      return
    }

    if (snapshotKey(beforeSnapshot) === snapshotKey(afterSnapshot)) {
      return
    }

    undoStackRef.current.push(beforeSnapshot)
    redoStackRef.current = []
    syncHistoryState()
  }, [snapshotKey, syncHistoryState])

  const handleUndo = useCallback(() => {
    const previousSnapshot = undoStackRef.current.pop()
    if (!previousSnapshot) {
      syncHistoryState()
      return
    }

    const currentSnapshot = captureProjectSnapshot()
    redoStackRef.current.push(currentSnapshot)
    restoreProjectSnapshot(previousSnapshot)
    syncHistoryState()
  }, [captureProjectSnapshot, restoreProjectSnapshot, syncHistoryState])

  const handleRedo = useCallback(() => {
    const nextSnapshot = redoStackRef.current.pop()
    if (!nextSnapshot) {
      syncHistoryState()
      return
    }

    const currentSnapshot = captureProjectSnapshot()
    undoStackRef.current.push(currentSnapshot)
    restoreProjectSnapshot(nextSnapshot)
    syncHistoryState()
  }, [captureProjectSnapshot, restoreProjectSnapshot, syncHistoryState])

  useEffect(() => {
    const canvas = canvasRef.current
    const workspace = workspaceRef.current
    if (!canvas || !workspace) {
      return undefined
    }

    const scope = createPaperScope(canvas)
    scopeRef.current = scope
    scope.project.selectedColor = new scope.Color(1, 1, 1)
    scope.settings.handleSize = 8
    let lastTouchPoint = null

    canvas.style.cursor = 'grab'

    const syncCanvasToWorkspace = () => {
      const width = workspace.clientWidth || CANVAS_WIDTH
      const height = workspace.clientHeight || CANVAS_HEIGHT

      setViewportSize({ width, height })
      canvas.width = width
      canvas.height = height
      canvas.style.width = '100%'
      canvas.style.height = '100%'

      scope.view.viewSize = new scope.Size(width, height)

      const layerBounds = scope.project.activeLayer?.bounds
      if (layerBounds && !layerBounds.isEmpty()) {
        scope.view.center = layerBounds.center
      }

      fitToView()
      scope.view.update()
    }

    const handleResize = () => {
      syncCanvasToWorkspace()
    }

    scope.view.onResize = handleResize

    const pointFromClient = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect()
      const scaleX = rect.width ? canvas.width / rect.width : 1
      const scaleY = rect.height ? canvas.height / rect.height : 1

      return new scope.Point(
        (clientX - rect.left) * scaleX,
        (clientY - rect.top) * scaleY,
      )
    }

    const touchPointFromEvent = (event) => {
      const touch = event.touches?.[0] || event.changedTouches?.[0]
      if (!touch) {
        return null
      }

      return pointFromClient(touch.clientX, touch.clientY)
    }

    const clearSelection = () => {
      interactiveItemsRef.current.forEach((item) => {
        if (!item?.removed) {
          item.selected = false
          item.fullySelected = false
        }
      })
      activeItemRef.current = null
      activeSegmentRef.current = null
      scope.view.update()
    }

    const setActiveItem = (item) => {
      interactiveItemsRef.current.forEach((currentItem) => {
        if (!currentItem?.removed) {
          const isTarget = currentItem === item
          currentItem.selected = isTarget
          currentItem.fullySelected = isTarget
        }
      })
      activeItemRef.current = item
      scope.view.update()
    }

    const setCanvasCursor = (cursor) => {
      canvas.style.cursor = cursor
    }

    const handlePointerDown = (point) => {
      const hitResult = scope.project.hitTest(point, {
        fill: true,
        stroke: true,
        segments: true,
        tolerance: 5,
      })

      panModeRef.current = !hitResult?.item?.data?.interactive

      if (!hitResult?.item?.data?.interactive) {
        clearSelection()
        if (panModeRef.current) {
          setCanvasCursor('grabbing')
        }
        return
      }

      setCanvasCursor('default')

      if (hitResult.type === 'segment' && hitResult.segment) {
        interactionStartSnapshotRef.current = captureProjectSnapshot()
        setActiveItem(hitResult.item)
        activeSegmentRef.current = hitResult.segment
        return
      }

      if (hitResult.type === 'fill' || hitResult.type === 'stroke') {
        interactionStartSnapshotRef.current = captureProjectSnapshot()
        setActiveItem(hitResult.item)
        activeSegmentRef.current = null
        return
      }

      clearSelection()
    }

    const handlePointerDrag = (delta) => {
      if (activeSegmentRef.current) {
        activeSegmentRef.current.point = activeSegmentRef.current.point.add(delta)
        scope.view.update()
        setCanvasCursor('default')
        return
      }

      if (activeItemRef.current) {
        activeItemRef.current.position = activeItemRef.current.position.add(delta)
        scope.view.update()
        setCanvasCursor('default')
        return
      }

      if (panModeRef.current) {
        scope.view.center = scope.view.center.subtract(delta)
        scope.view.update()
        setCanvasCursor('grabbing')
      }
    }

    const handlePointerUp = () => {
      const beforeSnapshot = interactionStartSnapshotRef.current
      const afterSnapshot = captureProjectSnapshot()
      pushHistorySnapshot(beforeSnapshot, afterSnapshot)
      interactionStartSnapshotRef.current = null
      lastTouchPoint = null
      panModeRef.current = false
      setCanvasCursor('grab')
    }

    const tool = new scope.Tool()

    tool.onMouseDown = (event) => {
      handlePointerDown(event.point)
    }

    tool.onMouseDrag = (event) => {
      handlePointerDrag(event.delta)
    }

    tool.onMouseUp = () => {
      handlePointerUp()
    }

    const onWheel = (event) => {
      event.preventDefault()

      const zoomFactor = event.deltaY < 0 ? 1.05 : 0.95
      const mousePosition = scope.view.viewToProject(new scope.Point(event.offsetX, event.offsetY))
      const newZoom = clamp(scope.view.zoom * zoomFactor, 0.05, 15)
      const beta = scope.view.zoom / newZoom
      const difference = mousePosition.subtract(scope.view.center)

      scope.view.center = mousePosition.subtract(difference.multiply(beta))
      scope.view.zoom = newZoom
      scope.view.update()
    }

    const onTouchStart = (event) => {
      if (event.touches.length > 1) {
        return
      }

      const point = touchPointFromEvent(event)
      if (!point) {
        return
      }

      event.preventDefault()
      lastTouchPoint = point
      handlePointerDown(point)
    }

    const onTouchMove = (event) => {
      if (event.touches.length > 1) {
        return
      }

      const point = touchPointFromEvent(event)
      if (!point) {
        return
      }

      event.preventDefault()
      if (lastTouchPoint) {
        handlePointerDrag(point.subtract(lastTouchPoint))
      }
      lastTouchPoint = point
    }

    const onTouchEnd = (event) => {
      event.preventDefault()
      handlePointerUp()
    }

    toolRef.current = tool

    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(workspace)
    window.addEventListener('resize', handleResize)
    canvas.addEventListener('touchstart', onTouchStart, { passive: false })
    canvas.addEventListener('touchmove', onTouchMove, { passive: false })
    canvas.addEventListener('touchend', onTouchEnd, { passive: false })
    canvas.addEventListener('touchcancel', onTouchEnd, { passive: false })
    canvas.addEventListener('wheel', onWheel, { passive: false })

    syncCanvasToWorkspace()

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', handleResize)
      scope.view.onResize = null
      canvas.removeEventListener('touchstart', onTouchStart)
      canvas.removeEventListener('touchmove', onTouchMove)
      canvas.removeEventListener('touchend', onTouchEnd)
      canvas.removeEventListener('touchcancel', onTouchEnd)
      canvas.removeEventListener('wheel', onWheel)

      if (toolRef.current) {
        toolRef.current.remove()
        toolRef.current = null
      }

      activeItemRef.current = null
      activeSegmentRef.current = null
      interactiveItemsRef.current = []
      interactionStartSnapshotRef.current = null

      if (scopeRef.current?.project) {
        scopeRef.current.project.clear()
        scopeRef.current.project.remove()
      }

      scopeRef.current = null
    }
  }, [captureProjectSnapshot, fitToView, pushHistorySnapshot])

  const layout = useMemo(() => {
    if (!font || text.length === 0) {
      return { glyphs: [], width: 0 }
    }

    const activeIndex = clamp(activePairIndex, 0, Math.max(0, text.length - 2))
    return layoutGlyphs(
      font,
      text,
      fontSize,
      tracking,
      manualKerning,
      activeIndex,
      { startX: 50, startY: viewportSize.height * 0.72 },
    )
  }, [font, text, fontSize, tracking, manualKerning, activePairIndex, viewportSize.height])

  const baselineY = viewportSize.height * 0.72

  const renderedGlyphs = useMemo(() => {
    if (!font || !layout.glyphs.length) {
      return []
    }

    return layout.glyphs.map((item, index) => {
      const path = item.glyph.getPath(item.x, item.y, fontSize, {
        kerning: false,
      })

      return {
        id: `${item.char}-${index}`,
        char: item.char,
        d: path.toPathData(4),
      }
    })
  }, [font, layout.glyphs, fontSize])

  const visibleArchivePair = archivePair.slice(0, 2)
  useEffect(() => {
    if (!archiveMode || !font || visibleArchivePair.length !== 2) {
      setArchiveLivePath('')
      return
    }

    const scope = scopeRef.current
    if (!scope) {
      setArchiveLivePath('')
      return
    }

    const archiveLayout = layoutGlyphs(font, visibleArchivePair, fontSize, tracking, manualKerning, 0, {
      startX: 50,
      startY: baselineY,
    })
    if (archiveLayout.glyphs.length < 2) {
      setArchiveLivePath('')
      return
    }

    const left = archiveLayout.glyphs[0]
    const right = archiveLayout.glyphs[1]
    const nextArchivePath = computePairCounterform({
      scope,
      leftGlyph: left.glyph,
      rightGlyph: right.glyph,
      leftX: left.x,
      rightX: right.x,
      baselineY,
      fontSize,
      font,
      leftChar: visibleArchivePair[0],
      rightChar: visibleArchivePair[1],
    })

    setArchiveLivePath(nextArchivePath)
  }, [archiveMode, baselineY, font, fontSize, manualKerning, tracking, visibleArchivePair, viewportSize.width])

  const visibleCounterforms = useMemo(() => {
    if (archiveMode) {
      return visibleArchivePair.length === 2 && archiveLivePath
        ? [{ id: visibleArchivePair, label: `${visibleArchivePair[0]}_${visibleArchivePair[1]}`, d: archiveLivePath }]
        : []
    }

    if (extracted) {
      return extractedCounterforms.filter((pair) => pair.d)
    }

    return []
  }, [archiveLivePath, archiveMode, visibleArchivePair, extracted, extractedCounterforms])

  useEffect(() => {
    const onKeyDown = (event) => {
      const tag = document.activeElement?.tagName
      const isInput = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'

      if ((event.metaKey || event.ctrlKey) && event.code === 'KeyZ' && !isInput) {
        event.preventDefault()
        if (event.shiftKey) {
          handleRedo()
        } else {
          handleUndo()
        }
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !isInput) {
        const scope = scopeRef.current
        const activeItem = activeItemRef.current
        if (scope && activeItem && !activeItem.removed) {
          event.preventDefault()
          const beforeSnapshot = captureProjectSnapshot()
          activeItem.remove()
          activeItemRef.current = null
          activeSegmentRef.current = null
          scope.view.update()
          const afterSnapshot = captureProjectSnapshot()
          pushHistorySnapshot(beforeSnapshot, afterSnapshot)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [handleRedo, handleUndo, captureProjectSnapshot, pushHistorySnapshot])

  useEffect(() => {
    const scope = scopeRef.current
    if (!scope) {
      return
    }

    scope.project.clear()
    interactiveItemsRef.current = []
    activeItemRef.current = null
    activeSegmentRef.current = null
    const preservedCenter = scope.view.center.clone()
    const preservedZoom = scope.view.zoom

    if (canvasEmpty) {
      resetHistory()
      scope.view.update()
      return
    }

    const addPathItem = (shape, interactive = false) => {
      if (!shape.d) {
        return null
      }

      const item = new scope.CompoundPath({
        pathData: shape.d,
        fillColor: 'black',
        strokeWidth: 0,
      })
      item.data.interactive = interactive
      item.data.label = shape.label || shape.id

      if (interactive) {
        interactiveItemsRef.current.push(item)
      }

      return item
    }

    if (!archiveMode && !extracted) {
      renderedGlyphs.forEach((glyph) => {
        addPathItem(glyph, false)
      })
    } else {
      visibleCounterforms.forEach((shape) => {
        addPathItem(shape, true)
      })
    }

    resetHistory()
    scope.view.center = preservedCenter
    scope.view.zoom = preservedZoom
    scope.view.update()
  }, [archiveMode, canvasEmpty, extracted, renderedGlyphs, resetHistory, visibleCounterforms])

  const pairOptions = useMemo(() => {
    if (text.length < 2) {
      return []
    }

    return text
      .split('')
      .slice(0, -1)
      .map((char, index) => ({ value: index, label: `${char}${text[index + 1]}` }))
  }, [text])

  const recomputeExtractedCounterforms = ({
    nextFont = font,
    nextText = text,
    nextFontSize = fontSize,
    nextTracking = tracking,
    nextManualKerning = manualKerning,
    nextActivePairIndex = activePairIndex,
  } = {}) => {
    const scope = scopeRef.current
    if (!scope || !nextFont || nextText.length < 2) {
      setExtractedCounterforms([])
      return
    }

    const boundedPairIndex = clamp(nextActivePairIndex, 0, Math.max(0, nextText.length - 2))
    const layoutAnchor = layout.glyphs[0]
    const localStartX = layoutAnchor?.x ?? 50
    const localBaselineY = layoutAnchor?.y ?? viewportSize.height * 0.72
    const localLayout = layoutGlyphs(
      nextFont,
      nextText,
      nextFontSize,
      nextTracking,
      nextManualKerning,
      boundedPairIndex,
      { startX: localStartX, startY: localBaselineY },
    )

    const nextCounterforms = localLayout.glyphs.slice(0, -1).map((item, index) => {
      const right = localLayout.glyphs[index + 1]
      const pathData = computePairCounterform({
        scope,
        leftGlyph: item.glyph,
        rightGlyph: right.glyph,
        leftX: item.x,
        rightX: right.x,
        baselineY: localBaselineY,
        fontSize: nextFontSize,
        font: nextFont,
        leftChar: item.char,
        rightChar: right.char,
      })

      return {
        id: `${item.char}-${right.char}-${index}`,
        label: `${item.char}_${right.char}`,
        d: pathData,
      }
    })

    setExtractedCounterforms(nextCounterforms)
  }

  const startArchiveGeneration = (nextFont, nextFontSize) => {
    const scope = scopeRef.current
    if (!scope || !nextFont) {
      return
    }

    const runId = archiveRunRef.current + 1
    archiveRunRef.current = runId

    const pairs = []
    for (const first of ALPHABET) {
      for (const second of ALPHABET) {
        pairs.push(`${first}${second}`)
      }
    }

    setArchiveData({})
    setArchiveProgress(0)
    setArchiveReady(false)
    setIsGeneratingArchive(true)

    const baseline = viewportSize.height * 0.72
    const chunkSize = 28

    const processChunk = (startIndex) => {
      if (archiveRunRef.current !== runId) {
        return
      }

      const chunk = pairs.slice(startIndex, startIndex + chunkSize)
      const generatedChunk = {}

      chunk.forEach((pair) => {
        const leftGlyph = nextFont.charToGlyph(pair[0])
        const rightGlyph = nextFont.charToGlyph(pair[1])
        const leftPath = leftGlyph.getPath(200, baseline, nextFontSize, { kerning: false })
        const leftBounds = leftPath.getBoundingBox()
        const rightX = leftBounds.x2 + 60

        const d = computePairCounterform({
          scope,
          leftGlyph,
          rightGlyph,
          leftX: 200,
          rightX,
          baselineY: baseline,
          fontSize: nextFontSize,
          font: nextFont,
          leftChar: pair[0],
          rightChar: pair[1],
        })

        generatedChunk[pair] = d
      })

      setArchiveData((prev) => ({ ...prev, ...generatedChunk }))
      const completed = startIndex + chunk.length
      setArchiveProgress(clamp(completed / pairs.length, 0, 1))

      if (completed >= pairs.length) {
        if (archiveRunRef.current === runId) {
          setArchiveReady(true)
          setIsGeneratingArchive(false)
        }
        return
      }

      window.setTimeout(() => {
        processChunk(completed)
      }, 0)
    }

    try {
      processChunk(0)
    } catch {
      if (archiveRunRef.current === runId) {
        setError('Archive generation failed for this font.')
        setIsGeneratingArchive(false)
      }
    }
  }

  const handleFontUpload = async (event) => {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    setFontLoading(true)
    try {
      const buffer = await file.arrayBuffer()
      const loadedFont = opentype.parse(buffer)

      archiveRunRef.current += 1
      setArchiveData({})
      setArchiveProgress(0)
      setArchiveReady(false)
      setIsGeneratingArchive(false)
      setExtractedCounterforms([])

      setFont(loadedFont)
      setFontName(file.name.replace(/\.(otf|ttf)$/i, ''))
      setError('')
      setExtracted(false)
      setCanvasEmpty(false)

      startArchiveGeneration(loadedFont, fontSize)
    } catch {
      setError('Invalid font file. Please upload a valid .otf or .ttf file.')
    } finally {
      setFontLoading(false)
    }
  }

  const handlePreloadedFontSelect = async (event) => {
    const selectedName = event.target.value
    if (!selectedName) return

    const entry = PRELOADED_FONTS.find((f) => f.name === selectedName)
    if (!entry) return

    setFontLoading(true)
    setError('')
    try {
      const loadedFont = await loadFontFromUrl(entry.url)

      archiveRunRef.current += 1
      setArchiveData({})
      setArchiveProgress(0)
      setArchiveReady(false)
      setIsGeneratingArchive(false)
      setExtractedCounterforms([])

      setFont(loadedFont)
      setFontName(entry.name)
      setExtracted(false)
      setCanvasEmpty(false)

      startArchiveGeneration(loadedFont, fontSize)
    } catch {
      setError(`Failed to load ${entry.name}. Try uploading a font file instead.`)
    } finally {
      setFontLoading(false)
    }
  }

  const handleTextChange = (event) => {
    const nextText = event.target.value
    const boundedPairIndex = clamp(activePairIndex, 0, Math.max(0, nextText.length - 2))

    setText(nextText)
    setCanvasEmpty(false)
    setActivePairIndex(boundedPairIndex)

    if (extracted) {
      recomputeExtractedCounterforms({
        nextText,
        nextActivePairIndex: boundedPairIndex,
      })
    }
  }

  const handleTrackingChange = (event) => {
    const nextTracking = Number(event.target.value)
    setTracking(nextTracking)
    setCanvasEmpty(false)

    if (extracted) {
      recomputeExtractedCounterforms({ nextTracking })
    }
  }

  const handleManualKerningChange = (event) => {
    const nextManualKerning = Number(event.target.value)
    setManualKerning(nextManualKerning)
    setCanvasEmpty(false)

    if (extracted) {
      recomputeExtractedCounterforms({ nextManualKerning })
    }
  }

  const handleActivePairChange = (event) => {
    const nextActivePairIndex = Number(event.target.value)
    setActivePairIndex(nextActivePairIndex)
    setCanvasEmpty(false)

    if (extracted) {
      recomputeExtractedCounterforms({ nextActivePairIndex })
    }
  }

  const handleFontSizeChange = (event) => {
    const nextFontSize = Number(event.target.value) || 80
    setFontSize(nextFontSize)
    setCanvasEmpty(false)

    if (font) {
      startArchiveGeneration(font, nextFontSize)
    }

    if (extracted) {
      recomputeExtractedCounterforms({ nextFontSize })
    }
  }

  const handleExtract = () => {
    setCanvasEmpty(false)
    recomputeExtractedCounterforms()
    setExtracted(true)
  }

  const handleViewOriginal = () => {
    setArchiveMode(false)
    setExtracted(false)
    setCanvasEmpty(false)
    setError('')

    const scope = scopeRef.current
    if (scope?.project) {
      scope.project.clear()
      scope.view.update()
    }

    activeItemRef.current = null
    activeSegmentRef.current = null
    interactiveItemsRef.current = []
  }

  const handleArchivePairChange = (event) => {
    const nextArchivePair = event.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2)
    setArchivePair(nextArchivePair)
    setCanvasEmpty(false)
  }

  const handleDownload = async () => {
    if (archiveMode) {
      if (!archiveReady) {
        setError('Archive is still generating. Please wait.')
        return
      }

      const zip = new JSZip()
      Object.entries(archiveData).forEach(([pair, d]) => {
        const svg = buildSvgString({ width: viewportSize.width, height: viewportSize.height, pathData: d })
        zip.file(`counterform_${pair[0]}_${pair[1]}.svg`, svg)
      })

      const blob = await zip.generateAsync({ type: 'blob' })
      saveAs(blob, 'counterforms_archive.zip')
      return
    }

    const liveVisibleCounterforms = interactiveItemsRef.current
      .filter((item) => !item.removed)
      .map((item, index) => ({
        d: item.pathData || '',
        label: item.data?.label || `counterform_${index}`,
      }))

    const exportList = liveVisibleCounterforms.length ? liveVisibleCounterforms : visibleCounterforms

    if (!exportList.length) {
      setError('Nothing to export. Extract counterforms first.')
      return
    }

    if (exportList.length === 1) {
      const only = exportList[0]
      const svg = buildSvgString({ width: viewportSize.width, height: viewportSize.height, pathData: only.d })
      saveAs(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `counterform_${only.label}.svg`)
      return
    }

    const zip = new JSZip()
    exportList.forEach((item) => {
      const svg = buildSvgString({ width: viewportSize.width, height: viewportSize.height, pathData: item.d })
      zip.file(`counterform_${item.label}.svg`, svg)
    })

    const blob = await zip.generateAsync({ type: 'blob' })
    saveAs(blob, 'counterforms_visible.zip')
  }

  return (
    <main className="studio-shell">
      <header className="studio-header">
        <div className="header-brand">
          <h1 className="studio-title">Controforme</h1>
          <p className="studio-subtitle">counterform analysis tool — unibz</p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="burger-button"
            onClick={() => setSystemPanelOpen((value) => !value)}
            aria-label="Toggle system panel"
            aria-expanded={systemPanelOpen}
          >
            ☰
          </button>
          {!extracted && !archiveMode ? (
            <button type="button" className="cta-button" onClick={handleExtract} disabled={!font || text.length < 2}>
              Extract Counterforms
            </button>
          ) : (
            <button type="button" className="cta-button" onClick={handleViewOriginal}>
              ← Back to Glyphs
            </button>
          )}
          <button
            type="button"
            className="download-button"
            onClick={handleDownload}
            disabled={!extracted && !archiveMode}
            title="Download counterforms as SVG"
          >
            ↓ Download SVG
          </button>
        </div>
      </header>

      {showIntro ? (
        <div className="intro-overlay" role="dialog" aria-modal="true" aria-label="Intro manifesto">
          <section className="intro-modal">
            <button
              type="button"
              className="intro-close"
              onClick={() => setShowIntro(false)}
              aria-label="Close intro"
            >
              ×
            </button>
            <span className="intro-title">Controforme</span>
            <p>
              unibz — tool created by Leonardo Voltolini — Prof. Jakob Mayr — April 2026.
            </p>
            <p style={{ marginTop: 12 }}>
              Typography is the architecture of space, not just ink. Following Willi Kunz's micro-aesthetics, this tool extracts the negative space between letterforms — the counterforms. By turning the void into solid black mass, it exposes the true structural rhythm of your type.
            </p>
            <div className="intro-steps">
              <div className="intro-step"><span className="step-num">1</span> Select a font or upload your own</div>
              <div className="intro-step"><span className="step-num">2</span> Type the letters you want to analyze</div>
              <div className="intro-step"><span className="step-num">3</span> Click "Extract Counterforms" to reveal the negative space</div>
              <div className="intro-step"><span className="step-num">4</span> Download the counterforms as SVG files</div>
            </div>
            <button
              type="button"
              className="cta-button intro-start"
              onClick={() => setShowIntro(false)}
            >
              Start
            </button>
          </section>
        </div>
      ) : null}

      <div className="studio-body">
        <aside className="studio-sidebar">
          <section className="panel panel-soft">
            <h2>1 — Choose a Font</h2>

            <label className="field">
              <span>Preset Fonts</span>
              <select
                value={fontName}
                onChange={handlePreloadedFontSelect}
                disabled={fontLoading}
              >
                <option value="">Select a sans-serif…</option>
                {PRELOADED_FONTS.map((f) => (
                  <option key={f.name} value={f.name}>{f.name}</option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Or Upload Your Own (.otf, .ttf)</span>
              <input type="file" accept=".otf,.ttf" onChange={handleFontUpload} disabled={fontLoading} />
            </label>

            {fontLoading ? <p className="status-text">Loading font…</p> : null}
            {font && !fontLoading ? <p className="status-text font-active">Active: {fontName}</p> : null}
            {error ? <p className="status-text error">{error}</p> : null}
          </section>

          <section className="panel panel-soft">
            <h2>2 — Type Letters</h2>
            <label className="field">
              <span>Text</span>
              <input
                type="text"
                value={text}
                onChange={handleTextChange}
                placeholder="e.g. Hamburg"
              />
            </label>

            <label className="field compact">
              <span>Font Size</span>
              <input
                type="number"
                min={80}
                max={360}
                value={fontSize}
                onChange={handleFontSizeChange}
              />
            </label>
          </section>

          <section className="panel panel-soft">
            <h2>3 — Adjust Spacing</h2>

            <label className="field range-field">
              <span>Tracking {tracking.toFixed(0)} px</span>
              <input
                type="range"
                min={-80}
                max={200}
                step={1}
                value={tracking}
                onChange={handleTrackingChange}
              />
            </label>

            <label className="field compact">
              <span>Active Pair</span>
              <select
                value={activePairIndex}
                onChange={handleActivePairChange}
                disabled={pairOptions.length === 0}
              >
                {pairOptions.length === 0 ? <option value={0}>--</option> : null}
                {pairOptions.map((pair) => (
                  <option key={`${pair.label}-${pair.value}`} value={pair.value}>
                    {pair.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field range-field">
              <span>Manual Kerning {manualKerning.toFixed(0)} px</span>
              <input
                type="range"
                min={-220}
                max={220}
                step={1}
                value={manualKerning}
                onChange={handleManualKerningChange}
                disabled={!archiveMode && pairOptions.length === 0}
              />
            </label>
          </section>

          <section className="panel panel-soft">
            <h2>Archive</h2>
            <label className="toggle">
              <input
                type="checkbox"
                checked={archiveMode}
                onChange={(event) => setArchiveMode(event.target.checked)}
              />
              Generate All Pairs (A–z)
            </label>

            {archiveMode ? (
              <>
                <label className="field compact">
                  <span>Search Pair</span>
                  <input
                    type="text"
                    maxLength={2}
                    value={archivePair}
                    onChange={handleArchivePairChange}
                    placeholder="e.g. AV"
                    title="Type exactly two letters to preview that pair"
                  />
                </label>

                <p className="status-text">
                  {archivePair.length === 2
                    ? `Previewing ${archivePair.toUpperCase()}`
                    : 'Type two letters to preview a pair'}
                </p>
              </>
            ) : null}
          </section>

          {!font ? (
            <p className="hint-text">Select a font above to get started.</p>
          ) : !extracted && !archiveMode ? (
            <p className="hint-text">Preview your text on the canvas, then click "Extract Counterforms" in the header.</p>
          ) : null}
        </aside>

        <section className="studio-workspace" ref={workspaceRef} aria-label="Counterform canvas">
          <canvas
            ref={canvasRef}
            className="editor-canvas"
          />
        </section>
      </div>

      {systemPanelOpen ? (
        <aside className="system-drawer" aria-label="System panel">
          <button type="button" onClick={resetView}>
            Reset View
          </button>
          <button type="button" onClick={handleUndo} disabled={!canUndo} title="Cmd/Ctrl + Z">
            Undo
          </button>
          <button type="button" onClick={handleRedo} disabled={!canRedo} title="Cmd/Ctrl + Shift + Z">
            Redo
          </button>
          <button type="button" onClick={handleDownload}>
            Download SVGs
          </button>
          <button type="button" onClick={clearCanvas}>
            Clear Canvas
          </button>
        </aside>
      ) : null}
    </main>
  )
}

export default App
