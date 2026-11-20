import type { ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { visualizeMetaFrom, type VisualizeMeta } from '../fragment.ts'

export const CARD_RESULT_KIND = 'dsh-visualize-result'

export interface TurnCard {
  readonly callId: string
  readonly seq: number
  readonly meta: VisualizeMeta
}

interface CardResult extends TurnCard {
  readonly rootCallId?: string
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    [CARD_RESULT_KIND]: CardResult
  }
}

type CardEvent = Parameters<ConversationNodeDefinition['match']>[0]

/** PTC is optional on the host, and older type bundles do not declare its events. */
interface PtcResultData {
  readonly subCallId: string
  readonly rootCallId: string
  readonly name: string
  readonly isError: boolean
  readonly meta?: unknown
}

export function nativeCard(event: Extract<CardEvent, { type: 'tool/result' }>): TurnCard | undefined {
  const { message, meta: raw } = event.data
  const meta = message.isError === true ? undefined : visualizeMetaFrom(raw)
  return meta === undefined ? undefined : { callId: String(message.source.callId), seq: event.seq, meta }
}

function cardResult(event: CardEvent): CardResult | undefined {
  if (event.type === 'tool/result') return nativeCard(event)
  if (String(event.type) !== 'tool/ptc-dispatch') return undefined
  const data = event.data as PtcResultData
  if (data.name !== 'visualize' || data.isError) return undefined
  const meta = visualizeMetaFrom(data.meta)
  return meta === undefined ? undefined : { callId: data.subCallId, rootCallId: data.rootCallId, seq: event.seq, meta }
}

/** One hidden Chat node per successful call. Chat indexes them by the engine-resolved Turn. */
export const cardResultDefinition: ConversationNodeDefinition<CardResult> = {
  kind: CARD_RESULT_KIND,
  target: 'chat',
  match: (event) => {
    const card = cardResult(event)
    return card === undefined ? null : { id: card.callId, role: 'start' }
  },
  start: (_context, match) => {
    const card = cardResult(match.event)
    if (card === undefined) throw new Error('dsh-visualize: result node requires card metadata')
    return card
  },
  // A later surface replacement of the same call is not a new card version.
  update: context => context.state,
  buildViewNode: (context) => {
    const { start, state } = context
    if (start === undefined || state === undefined) return null
    return {
      key: context.key, kind: CARD_RESULT_KIND, id: context.id, target: 'chat',
      anchorSeq: state.seq, location: start.location, visibility: 'hidden', data: state,
    } satisfies ChatNode<typeof CARD_RESULT_KIND>
  },
}

/** Read only the indexed results for this Turn; old Chat hosts lack the index. */
export function turnCardResults(chat: ChatSnapshot, turn: number): readonly CardResult[] | undefined {
  return chat.nodes?.turnDataSource?.(turn, CARD_RESULT_KIND).getSnapshot()
}

/** Keep the latest result before the closing reply, in each path's original position. */
export function latestCardsBefore(results: readonly TurnCard[], seq: number): readonly TurnCard[] {
  const byPath = new Map<string, TurnCard>()
  for (const card of results) {
    if (card.seq >= seq) break
    byPath.set(card.meta.path, card)
  }
  return [...byPath.values()]
}

/**
 * A result is superseded by a later successful version of the same card path
 * in the same Turn, whether either call was native or a PTC dispatch.
 */
export function isSuperseded(chat: ChatSnapshot, callId: string): boolean {
  // Conversation Context keys are length-prefixed kinds followed by the Definition's id.
  const node = chat.nodes?.get(`${CARD_RESULT_KIND.length}:${CARD_RESULT_KIND}${callId}`) as
    ChatNode<typeof CARD_RESULT_KIND> | undefined
  if (node === undefined) return false
  const location = node.location
  if (location.kind !== 'turn' && location.kind !== 'step') return false
  const current = node.data
  return turnCardResults(chat, location.turn.turn)?.some(card => card.seq > current.seq
    && card.meta.path === current.meta.path) ?? false
}
