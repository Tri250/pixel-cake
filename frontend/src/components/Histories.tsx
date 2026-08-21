import React from 'react'
import { HistoryItem, AdjustParams } from '../App'

interface HistoriesProps {
  history: HistoryItem[]
  currentIndex: number
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onSelect: (index: number) => void
}

const Histories: React.FC<HistoriesProps> = ({
  history,
  currentIndex,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSelect,
}) => {
  const formatParams = (p: AdjustParams): string => {
    const parts: string[] = []
    if (p.brightness !== 0) parts.push(`亮度${p.brightness > 0 ? '+' : ''}${p.brightness.toFixed(2)}`)
    if (p.contrast !== 0) parts.push(`对比${p.contrast > 0 ? '+' : ''}${p.contrast.toFixed(2)}`)
    if (p.saturation !== 0) parts.push(`饱和${p.saturation > 0 ? '+' : ''}${p.saturation.toFixed(2)}`)
    if (p.warmth !== 0) parts.push(`色温${p.warmth > 0 ? '+' : ''}${p.warmth.toFixed(2)}`)
    if (p.sharpness !== 0) parts.push(`锐化${p.sharpness > 0 ? '+' : ''}${p.sharpness.toFixed(2)}`)
    return parts.length > 0 ? parts.join(' ') : '原图'
  }

  return (
    <div className="flex items-center gap-1">
      {/* 撤销 */}
      <button
        onClick={onUndo}
        disabled={!canUndo}
        title="撤销 (Ctrl+Z)"
        className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-dark-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        ↩
      </button>
      {/* 重做 */}
      <button
        onClick={onRedo}
        disabled={!canRedo}
        title="重做 (Ctrl+Y)"
        className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-dark-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        ↪
      </button>
      {/* 历史记录列表（最近 5 条） */}
      {history.length > 0 && (
        <div className="flex items-center gap-1 ml-2">
          <span className="text-xs text-dark-500">历史:</span>
          {history.slice(-5).map((item, i) => {
            const actualIndex = history.length - 5 + i
            const isCurrent = actualIndex === currentIndex
            return (
              <button
                key={item.id}
                onClick={() => onSelect(actualIndex)}
                title={formatParams(item.params)}
                className={`w-6 h-6 rounded text-xs font-medium transition-colors ${
                  isCurrent
                    ? 'bg-cake-500 text-white'
                    : 'bg-dark-700 text-dark-300 hover:bg-dark-600'
                }`}
              >
                {i + 1}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default Histories
