import React, { useState, useCallback, useRef, useEffect } from 'react'
import Header from './components/Header'
import Canvas from './components/Canvas'
import Sidebar from './components/Sidebar'
import BeforeAfter from './components/BeforeAfter'
import BatchProcess from './components/BatchProcess'
import Toolbar from './components/Toolbar'
import Histories from './components/Histories'

// ─── 类型定义 ───

export type Tool = 'select' | 'hand' | 'brush' | 'eraser' | 'auto-person' | 'auto-sky' | 'inpaint' | 'crop'
export type AdjustMode = 'basic' | 'color' | 'detail' | 'filter' | 'ai'
export type AIFeature =
  | 'remove-person' | 'remove-tattoo' | 'remove-stubble' | 'remove-flaw'
  | 'relight' | 'fill-grass' | 'sky-replace' | 'skin-smooth'
  | 'teeth-whiten' | 'face-slim' | 'hair-smooth' | 'makeup' | 'color-match'

export interface ImageInfo {
  id: string
  url: string
  filename?: string
  width?: number
  height?: number
}

export interface AdjustParams {
  brightness: number
  contrast: number
  saturation: number
  warmth: number
  sharpness: number
  denoise: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  vibrance: number
  clarity: number
  tint: number
}

const DEFAULT_PARAMS: AdjustParams = {
  brightness: 0, contrast: 0, saturation: 0, warmth: 0,
  sharpness: 0, denoise: 0, highlights: 0, shadows: 0,
  whites: 0, blacks: 0, vibrance: 0, clarity: 0, tint: 0,
}

// ─── 历史记录项 ───
export interface HistoryItem {
  id: number
  imageId: string
  params: AdjustParams
  filter: string | null
  filterIntensity: number
}

// ─── App ───
export default function App() {
  const [image, setImage] = useState<ImageInfo | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [activeResultId, setActiveResultId] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [brushSize, setBrushSize] = useState(30)
  const [zoom, setZoom] = useState(1)
  const [mode, setMode] = useState<AdjustMode>('basic')
  const [params, setParams] = useState<AdjustParams>({ ...DEFAULT_PARAMS })
  const [selectedFilter, setSelectedFilter] = useState<string | null>(null)
  const [filterIntensity, setFilterIntensity] = useState(1.0)
  const [isProcessing, setIsProcessing] = useState(false)
  const [showBeforeAfter, setShowBeforeAfter] = useState(false)
  const [showBatch, setShowBatch] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'error' | 'info' } | null>(null)

  // 历史记录（用于撤销/重做）
  const historyRef = useRef<HistoryItem[]>([])
  const historyIndexRef = useRef(-1)
  const historyIdRef = useRef(0)
  const [historyVersion, setHistoryVersion] = useState(0) // 触发重渲染

  // 存储当前图像状态的 URL 用于撤销
  const currentSnapshotRef = useRef<string | null>(null)

  // ─── Toast 通知 ───
  const showToast = useCallback((msg: string, type: 'error' | 'info' = 'info') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }, [])

  // ─── 上传图片 ───
  const handleUpload = useCallback(async (file: File) => {
    try {
      setIsProcessing(true)
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/upload', { method: 'POST', body: fd })
      if (!res.ok) throw new Error('上传失败')
      const data = await res.json()
      const url = URL.createObjectURL(file)
      // 释放之前的 URL
      if (image?.url) URL.revokeObjectURL(image.url)
      if (resultUrl) URL.revokeObjectURL(resultUrl)
      setImage({
        id: data.image_id,
        url,
        filename: data.filename,
        width: data.width,
        height: data.height,
      })
      setResultUrl(null)
      setActiveResultId(null)
      setParams({ ...DEFAULT_PARAMS })
      setSelectedFilter(null)
      historyRef.current = []
      historyIndexRef.current = -1
      setHistoryVersion(v => v + 1)
      showToast('图片上传成功', 'info')
    } catch (err: any) {
      showToast('上传失败: ' + err.message, 'error')
    } finally {
      setIsProcessing(false)
    }
  }, [image, resultUrl, showToast])

  // ─── 应用历史记录 ───
  const pushHistory = useCallback((imageId: string, p: AdjustParams, filter: string | null, intensity: number) => {
    historyIdRef.current += 1
    const item: HistoryItem = {
      id: historyIdRef.current,
      imageId,
      params: { ...p },
      filter,
      filterIntensity: intensity,
    }
    // 截断 redo 分支
    const hist = historyRef.current.slice(0, historyIndexRef.current + 1)
    hist.push(item)
    historyRef.current = hist
    historyIndexRef.current = hist.length - 1
    setHistoryVersion(v => v + 1)
  }, [])

  // ─── 撤销/重做 ───
  const handleUndo = useCallback(() => {
    if (historyIndexRef.current <= 0) return
    historyIndexRef.current -= 1
    const item = historyRef.current[historyIndexRef.current]
    // 重新加载该状态
    if (image) {
      // 用历史参数重新处理
      handleAdjust(item.params, item.filter, item.filterIntensity, true)
    }
    setHistoryVersion(v => v + 1)
  }, [image])

  const handleRedo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return
    historyIndexRef.current += 1
    const item = historyRef.current[historyIndexRef.current]
    if (image) {
      handleAdjust(item.params, item.filter, item.filterIntensity, true)
    }
    setHistoryVersion(v => v + 1)
  }, [image])

  const canUndo = historyIndexRef.current > 0
  const canRedo = historyIndexRef.current < historyRef.current.length - 1

  // ─── 跳转到指定历史记录 ───
  const goToHistory = useCallback((index: number) => {
    if (index < 0 || index >= historyRef.current.length) return
    historyIndexRef.current = index
    const item = historyRef.current[index]
    if (image) {
      handleAdjust(item.params, item.filter, item.filterIntensity, true)
    }
    setHistoryVersion(v => v + 1)
  }, [image])

  // ─── 核心：发送调整请求 ───
  const handleAdjust = useCallback(async (
    p: AdjustParams,
    filter: string | null = null,
    filterIntensityVal: number = 1.0,
    fromHistory: boolean = false
  ) => {
    if (!image) return
    setIsProcessing(true)
    try {
      let endpoint = '/api/enhance'
      let body: any = {
        image_id: image.id,
        brightness: p.brightness,
        contrast: p.contrast,
        saturation: p.saturation,
        warmth: p.warmth,
        sharpness: p.sharpness,
        denoise: p.denoise,
        highlights: p.highlights,
        shadows: p.shadows,
        whites: p.whites,
        blacks: p.blacks,
        vibrance: p.vibrance,
        clarity: p.clarity,
        tint: p.tint,
      }

      if (filter) {
        body.filter = filter
        body.filter_intensity = filterIntensityVal
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`API 错误: ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const resultId = res.headers.get('X-Result-Id') || `result_${Date.now()}`

      // 释放旧结果
      if (resultUrl) URL.revokeObjectURL(resultUrl)
      setResultUrl(url)
      setActiveResultId(resultId)

      // 非历史回放时推入历史
      if (!fromHistory) {
        pushHistory(image.id, p, filter, filterIntensityVal)
      }
    } catch (err: any) {
      showToast('调整失败: ' + err.message, 'error')
    } finally {
      setIsProcessing(false)
    }
  }, [image, resultUrl, pushHistory, showToast])

  // ─── 参数变更（debounced） ───
  const lastApplyRef = useRef<number>(0)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleParamsChange = useCallback((partial: Partial<AdjustParams>) => {
    const newParams = { ...params, ...partial }
    setParams(newParams)

    if (!image) return
    // 防抖：300ms 内的变更合并
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(() => {
      handleAdjust(newParams, selectedFilter, filterIntensity)
    }, 300)
  }, [params, image, selectedFilter, filterIntensity, handleAdjust])

  // ─── 滤镜选择 ───
  const handleFilterSelect = useCallback(async (name: string, intensity?: number) => {
    const newIntensity = intensity ?? filterIntensity
    setSelectedFilter(name)
    setFilterIntensity(newIntensity)
    if (!image) return
    setIsProcessing(true)
    try {
      const res = await fetch('/api/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_id: image.id,
          filter: name,
          filter_intensity: newIntensity,
          brightness: params.brightness,
          contrast: params.contrast,
          saturation: params.saturation,
          warmth: params.warmth,
          highlights: params.highlights,
          shadows: params.shadows,
          whites: params.whites,
          blacks: params.blacks,
          vibrance: params.vibrance,
          clarity: params.clarity,
          tint: params.tint,
        }),
      })
      if (!res.ok) throw new Error(`滤镜失败: ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const resultId = res.headers.get('X-Result-Id') || `result_${Date.now()}`
      if (resultUrl) URL.revokeObjectURL(resultUrl)
      setResultUrl(url)
      setActiveResultId(resultId)
      pushHistory(image.id, params, name, newIntensity)
    } catch (err: any) {
      showToast('滤镜失败: ' + err.message, 'error')
    } finally {
      setIsProcessing(false)
    }
  }, [image, params, resultUrl, filterIntensity, pushHistory, showToast])

  // ─── AI 功能 ───
  const handleAIFeature = useCallback(async (feature: AIFeature) => {
    if (!image) return
    setIsProcessing(true)
    try {
      let endpoint = ''
      let body: any = {}

      switch (feature) {
        case 'remove-person':
        case 'remove-tattoo':
        case 'remove-stubble':
        case 'remove-flaw': {
          // 先自动分割，再 inpaint
          const segRes = await fetch('/api/auto-segment', {
            method: 'POST',
            body: new URLSearchParams({
              image_id: image.id,
              mode: feature === 'remove-person' ? 'person' : 'skin',
            }),
          })
          const maskId = segRes.headers.get('X-Mask-Id')
          if (!maskId) throw new Error('分割失败')
          endpoint = '/api/inpaint'
          body = {
            image_id: image.id,
            mask_id: maskId,
            fill_type: undefined,
          }
          break
        }
        case 'sky-replace': {
          endpoint = '/api/sky/replace'
          body = { image_id: image.id, sky_type: 'sunset', blend_strength: 0.7 }
          break
        }
        case 'skin-smooth': {
          endpoint = '/api/enhance'
          body = { image_id: image.id, skin_smooth: true }
          break
        }
        case 'teeth-whiten': {
          const segRes = await fetch('/api/auto-segment', {
            method: 'POST',
            body: new URLSearchParams({ image_id: image.id, mode: 'teeth' }),
          })
          const maskId = segRes.headers.get('X-Mask-Id')
          if (!maskId) throw new Error('牙齿检测失败')
          endpoint = '/api/inpaint'
          body = { image_id: image.id, mask_id: maskId, fill_type: 'whiten' }
          break
        }
        case 'relight': {
          endpoint = '/api/relight'
          body = new URLSearchParams({ image_id: image.id, brightness: '0.3', warmth: '0.1' })
          const res = await fetch(endpoint, { method: 'POST', body })
          if (!res.ok) throw new Error('补光失败')
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          if (resultUrl) URL.revokeObjectURL(resultUrl)
          setResultUrl(url)
          const resultId = res.headers.get('X-Result-Id') || `result_${Date.now()}`
          setActiveResultId(resultId)
          pushHistory(image.id, params, selectedFilter, filterIntensity)
          showToast('补光完成', 'info')
          setIsProcessing(false)
          return
        }
        case 'fill-grass': {
          const segRes = await fetch('/api/auto-segment', {
            method: 'POST',
            body: new URLSearchParams({ image_id: image.id, mode: 'ground' }),
          })
          const maskId = segRes.headers.get('X-Mask-Id')
          if (!maskId) throw new Error('草地检测失败')
          endpoint = '/api/inpaint'
          body = { image_id: image.id, mask_id: maskId, fill_type: 'grass' }
          break
        }
        case 'face-slim': {
          endpoint = '/api/face-slim'
          body = new URLSearchParams({ image_id: image.id, strength: '0.3' })
          const res = await fetch(endpoint, { method: 'POST', body })
          if (!res.ok) throw new Error('瘦脸失败')
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          if (resultUrl) URL.revokeObjectURL(resultUrl)
          setResultUrl(url)
          const resultId = res.headers.get('X-Result-Id') || `result_${Date.now()}`
          setActiveResultId(resultId)
          pushHistory(image.id, params, selectedFilter, filterIntensity)
          showToast('瘦脸完成', 'info')
          setIsProcessing(false)
          return
        }
        case 'hair-smooth': {
          endpoint = '/api/hair-smooth'
          body = new URLSearchParams({ image_id: image.id, strength: '0.5' })
          const res = await fetch(endpoint, { method: 'POST', body })
          if (!res.ok) throw new Error('发丝处理失败')
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          if (resultUrl) URL.revokeObjectURL(resultUrl)
          setResultUrl(url)
          const resultId = res.headers.get('X-Result-Id') || `result_${Date.now()}`
          setActiveResultId(resultId)
          pushHistory(image.id, params, selectedFilter, filterIntensity)
          showToast('发丝处理完成', 'info')
          setIsProcessing(false)
          return
        }
        case 'color-match':
        case 'makeup': {
          // 这些通过各自的 Sidebar 面板触发
          setMode(feature === 'makeup' ? 'detail' : 'filter')
          showToast(
            feature === 'makeup' ? '请在细节面板调整妆容参数' : '请在滤镜面板上传参考图追色',
            'info'
          )
          setIsProcessing(false)
          return
        }
        default:
          throw new Error(`未知功能: ${feature}`)
      }

      if (endpoint && body) {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: endpoint === '/api/inpaint' || endpoint === '/api/enhance' || endpoint === '/api/sky/replace'
            ? { 'Content-Type': 'application/json' } : undefined,
          body: endpoint === '/api/inpaint' || endpoint === '/api/enhance' || endpoint === '/api/sky/replace'
            ? JSON.stringify(body) : body,
        })
        if (!res.ok) throw new Error(`API 错误: ${res.status}`)
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        if (resultUrl) URL.revokeObjectURL(resultUrl)
        setResultUrl(url)
        const resultId = res.headers.get('X-Result-Id') || `result_${Date.now()}`
        setActiveResultId(resultId)
        pushHistory(image.id, params, selectedFilter, filterIntensity)
        showToast(`${feature} 处理完成`, 'info')
      }
    } catch (err: any) {
      showToast('AI 处理失败: ' + err.message, 'error')
    } finally {
      setIsProcessing(false)
    }
  }, [image, resultUrl, params, selectedFilter, filterIntensity, pushHistory, showToast])

  // ─── 妆容自定义 ───
  const handleMakeupCustom = useCallback(async (opts: { lipstick?: number; blush?: number; eyeshadow?: number }) => {
    if (!image) return
    setIsProcessing(true)
    try {
      const res = await fetch('/api/makeup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_id: image.id,
          lipstick: opts.lipstick ?? 0,
          blush: opts.blush ?? 0,
          eyeshadow: opts.eyeshadow ?? 0,
        }),
      })
      if (!res.ok) throw new Error('妆容处理失败')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      if (resultUrl) URL.revokeObjectURL(resultUrl)
      setResultUrl(url)
      showToast('妆容已应用', 'info')
    } catch (err: any) {
      showToast('妆容失败: ' + err.message, 'error')
    } finally {
      setIsProcessing(false)
    }
  }, [image, resultUrl, showToast])

  // ─── AI 追色 ───
  const handleColorMatch = useCallback(async (refFile: File) => {
    if (!image) return
    setIsProcessing(true)
    try {
      const fd = new FormData()
      fd.append('image_id', image.id)
      fd.append('reference', refFile)
      const res = await fetch('/api/color-match', { method: 'POST', body: fd })
      if (!res.ok) throw new Error('追色失败')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      if (resultUrl) URL.revokeObjectURL(resultUrl)
      setResultUrl(url)
      showToast('追色完成', 'info')
    } catch (err: any) {
      showToast('追色失败: ' + err.message, 'error')
    } finally {
      setIsProcessing(false)
    }
  }, [image, resultUrl, showToast])

  // ─── 局部调色 ───
  const handleLocalAdjust = useCallback(async (
    localMode: 'subject' | 'background',
    adj: { brightness?: number; contrast?: number; saturation?: number; warmth?: number }
  ) => {
    if (!image) return
    setIsProcessing(true)
    try {
      // 先自动分割获取 mask
      const segRes = await fetch('/api/auto-segment', {
        method: 'POST',
        body: new URLSearchParams({
          image_id: image.id,
          mode: localMode === 'subject' ? 'person' : 'sky',
        }),
      })
      const maskId = segRes.headers.get('X-Mask-Id')
      if (!maskId) throw new Error('分割失败')
      const res = await fetch('/api/local-adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_id: image.id,
          mask_id: maskId,
          brightness: adj.brightness ?? 0,
          contrast: adj.contrast ?? 0,
          saturation: adj.saturation ?? 0,
          warmth: adj.warmth ?? 0,
        }),
      })
      if (!res.ok) throw new Error('局部调色失败')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      if (resultUrl) URL.revokeObjectURL(resultUrl)
      setResultUrl(url)
      showToast('局部调色完成', 'info')
    } catch (err: any) {
      showToast('局部调色失败: ' + err.message, 'error')
    } finally {
      setIsProcessing(false)
    }
  }, [image, resultUrl, showToast])

  // ─── 蒙版画布提交 inpaint ───
  const handleMaskInpaint = useCallback(async (maskBlob: Blob) => {
    if (!image) return
    setIsProcessing(true)
    try {
      // 上传 mask
      const maskFd = new FormData()
      maskFd.append('file', maskBlob, 'mask.png')
      const maskRes = await fetch('/api/upload', { method: 'POST', body: maskFd })
      if (!maskRes.ok) throw new Error('Mask 上传失败')
      const maskData = await maskRes.json()

      const res = await fetch('/api/inpaint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_id: image.id,
          mask_id: maskData.image_id,
        }),
      })
      if (!res.ok) throw new Error('修复失败')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      if (resultUrl) URL.revokeObjectURL(resultUrl)
      setResultUrl(url)
      const resultId = res.headers.get('X-Result-Id') || `result_${Date.now()}`
      setActiveResultId(resultId)
      showToast('AI 修复完成', 'info')
    } catch (err: any) {
      showToast('修复失败: ' + err.message, 'error')
    } finally {
      setIsProcessing(false)
    }
  }, [image, resultUrl, showToast])

  // ─── 下载 ───
  const handleDownload = useCallback(() => {
    if (!activeResultId) {
      showToast('没有可下载的结果', 'error')
      return
    }
    const a = document.createElement('a')
    a.href = `/api/download/${activeResultId}`
    a.download = `pixel-cake-${activeResultId}.jpg`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [activeResultId, showToast])

  // ─── 裁剪完成后更新 App 状态 ───
  const handleCropComplete = useCallback((newImageId: string, newUrl: string) => {
    if (image?.url) URL.revokeObjectURL(image.url)
    setImage(prev => prev ? { ...prev, id: newImageId, url: newUrl } : null)
    setResultUrl(null)
    setActiveResultId(null)
    setParams({ ...DEFAULT_PARAMS })
    historyRef.current = []
    historyIndexRef.current = -1
    setHistoryVersion(v => v + 1)
    showToast('裁剪完成', 'info')
  }, [image, showToast])

  // ─── 一键全套修图 ───
  const handleAutoEnhance = useCallback(async () => {
    if (!image) return
    setIsProcessing(true)
    try {
      // 按顺序应用：去路人 → 换天空 → 磨皮 → 调色
      let currentImageId = image.id

      // 1. 自动去路人
      const seg1 = await fetch('/api/auto-segment', {
        method: 'POST',
        body: new URLSearchParams({ image_id: currentImageId, mode: 'person' }),
      })
      const mask1Id = seg1.headers.get('X-Mask-Id')
      if (mask1Id) {
        const inp1 = await fetch('/api/inpaint', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_id: currentImageId, mask_id: mask1Id }),
        })
        if (inp1.ok) {
          const blob1 = await inp1.blob()
          // 上传结果作为新图
          const fd1 = new FormData()
          fd1.append('file', blob1, 'step1.png')
          const up1 = await fetch('/api/upload', { method: 'POST', body: fd1 })
          if (up1.ok) currentImageId = (await up1.json()).image_id
        }
      }

      // 2. 换天空
      const skyRes = await fetch('/api/sky/replace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_id: currentImageId, sky_type: 'sunset' }),
      })
      if (skyRes.ok) {
        const blob2 = await skyRes.blob()
        const fd2 = new FormData()
        fd2.append('file', blob2, 'step2.png')
        const up2 = await fetch('/api/upload', { method: 'POST', body: fd2 })
        if (up2.ok) currentImageId = (await up2.json()).image_id
      }

      // 3. 磨皮
      const skinRes = await fetch('/api/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_id: currentImageId, skin_smooth: true }),
      })
      if (skinRes.ok) {
        const blob3 = await skinRes.blob()
        const fd3 = new FormData()
        fd3.append('file', blob3, 'step3.png')
        const up3 = await fetch('/api/upload', { method: 'POST', body: fd3 })
        if (up3.ok) currentImageId = (await up3.json()).image_id
      }

      // 4. 自动调色
      const enhRes = await fetch('/api/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_id: currentImageId,
          brightness: 0.05, contrast: 0.1, saturation: 0.05,
        }),
      })
      if (enhRes.ok) {
        const blob = await enhRes.blob()
        const url = URL.createObjectURL(blob)
        if (resultUrl) URL.revokeObjectURL(resultUrl)
        setResultUrl(url)
        const resultId = enhRes.headers.get('X-Result-Id') || `result_${Date.now()}`
        setActiveResultId(resultId)
        // 更新主图为最后一步
        setImage(prev => prev ? { ...prev, id: currentImageId } : prev)
        showToast('🚀 一键修图完成', 'info')
      }
    } catch (err: any) {
      showToast('自动修图失败: ' + err.message, 'error')
    } finally {
      setIsProcessing(false)
    }
  }, [image, resultUrl, showToast])

  // ─── 键盘快捷键 ───
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z') {
          e.preventDefault()
          handleUndo()
        } else if (e.key === 'y' || (e.shiftKey && e.key === 'Z')) {
          e.preventDefault()
          handleRedo()
        }
      }
      if (e.key === 'v') setTool('select')
      else if (e.key === 'h') setTool('hand')
      else if (e.key === 'b') setTool('brush')
      else if (e.key === 'e') setTool('eraser')
      else if (e.key === 'c') setTool('crop')
      else if (e.key === 'i') setTool('inpaint')
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleUndo, handleRedo])

  // ─── 清理：组件卸载时释放 URL ───
  useEffect(() => {
    return () => {
      if (image?.url) URL.revokeObjectURL(image.url)
      if (resultUrl) URL.revokeObjectURL(resultUrl)
    }
  }, [image, resultUrl])

  return (
    <div className="h-screen w-screen flex flex-col bg-dark-950 text-dark-100 overflow-hidden">
      <Header
        filename={image?.filename}
        onUpload={handleUpload}
        onDownload={handleDownload}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={canUndo}
        canRedo={canRedo}
        showBeforeAfter={showBeforeAfter}
        onToggleCompare={() => setShowBeforeAfter(v => !v)}
        showBatch={showBatch}
        onToggleBatch={() => setShowBatch(v => !v)}
        zoom={zoom}
        onZoomChange={setZoom}
      />

      {/* 历史记录条 */}
      <div className="px-4 py-1 border-b border-dark-800 bg-dark-900/50 flex items-center">
        <Histories
          history={historyRef.current}
          currentIndex={historyIndexRef.current}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onSelect={goToHistory}
        />
      </div>

      <div className="flex-1 flex overflow-hidden relative">
        {/* 左侧工具栏 */}
        <Toolbar
          tool={tool}
          onToolChange={setTool}
          brushSize={brushSize}
          onBrushSizeChange={setBrushSize}
        />

        {/* 中间画布 */}
        <div className="flex-1 relative overflow-hidden bg-dark-950">
          {showBatch ? (
            <BatchProcess />
          ) : showBeforeAfter && image && resultUrl ? (
            <BeforeAfter original={image.url} result={resultUrl} />
          ) : (
            <Canvas
              image={image}
              resultUrl={resultUrl}
              tool={tool}
              brushSize={brushSize}
              zoom={zoom}
              onZoomChange={setZoom}
              isProcessing={isProcessing}
              onAIFeature={handleAIFeature}
              onMaskInpaint={handleMaskInpaint}
              onClearTool={() => { /* handled by Canvas */ }}
              onError={(msg) => showToast(msg, 'error')}
              onCropComplete={handleCropComplete}
            />
          )}

          {/* 加载遮罩 */}
          {isProcessing && (
            <div className="absolute inset-0 bg-dark-950/50 backdrop-blur-sm flex items-center justify-center z-50">
              <div className="flex flex-col items-center gap-3">
                <div className="w-12 h-12 rounded-full border-4 border-cake-500 border-t-transparent animate-spin" />
                <p className="text-cake-400 text-sm font-medium">AI 处理中...</p>
              </div>
            </div>
          )}

          {/* Toast 通知 */}
          {toast && (
            <div
              className={`absolute top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-sm shadow-lg transition-all ${
                toast.type === 'error'
                  ? 'bg-red-600 text-white'
                  : 'bg-cake-600 text-white'
              }`}
            >
              {toast.msg}
            </div>
          )}
        </div>

        {/* 右侧面板 */}
        {!showBatch && (
          <Sidebar
            image={image}
            mode={mode}
            onModeChange={setMode}
            params={params}
            onParamsChange={handleParamsChange}
            onAIFeature={handleAIFeature}
            selectedFilter={selectedFilter}
            onFilterSelect={handleFilterSelect}
            filterIntensity={filterIntensity}
            onFilterIntensityChange={setFilterIntensity}
            isProcessing={isProcessing}
            onShowToast={showToast}
            onColorMatch={handleColorMatch}
            onLocalAdjust={handleLocalAdjust}
            onMakeupCustom={handleMakeupCustom}
            onAutoEnhance={handleAutoEnhance}
          />
        )}
      </div>
    </div>
  )
}
