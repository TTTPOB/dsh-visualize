// @vitest-environment jsdom
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, useState, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChatNode, ChatSnapshot, UseChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeAssembler, ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { cardResultDefinition } from '../src/client/card-results.ts'
import { TurnCards, turnCardsDefinition } from '../src/client/TurnCards.tsx'
import { VisualizeCard } from '../src/client/VisualizeCard.tsx'

const hostRoot = process.env.DSH_HOST_SOURCE ?? resolve('../deepseek-harness')
const client = resolve(hostRoot, 'packages/client')
const hasHostSource = existsSync(resolve(client, 'ui-conversation/src/client/conversation/assembler.ts'))
if (process.env.DSH_HOST_SOURCE && !hasHostSource) throw new Error(`Missing DSH Host source: ${hostRoot}`)

const Tail = TurnCards as unknown as ComponentType<Record<string, unknown>>
const Card = VisualizeCard as unknown as ComponentType<Record<string, unknown>>
function useDisclosure() {
  const [expanded, setExpanded] = useState(false)
  return { expanded, setExpanded, toggle: () => setExpanded(open => !open) }
}

type Entry = { type: 'event'; event: { type: string; seq: number; time: number; surfaceOp?: 'append'; data: Record<string, unknown> } }

function history() {
  const events: Entry[] = []
  let turn = 0
  let step = 0
  function log(type: string, data: Entry['event']['data'], surfaceOp?: 'append') {
    const seq = events.length + 1
    events.push({ type: 'event', event: { type, seq, time: seq, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) } })
  }
  function result(callId: string, meta?: object) {
    log('tool/result', {
      turn, step, ...(meta === undefined ? {} : { meta }),
      message: { role: 'tool', isError: false, content: [{ type: 'text', text: 'Done' }], source: { callId } },
    }, 'append')
  }
  function call(callId: string, name: string, args: object) {
    log('tool/call', { turn, step, callId, name, arguments: JSON.stringify(args) })
  }
  function startStep() { log('step/start', { turn, step: ++step }) }
  function endStep() { log('step/end', { turn, step }) }
  return {
    events,
    start() { log('turn/start', { turn: ++turn }); step = 0; startStep() },
    nextStep() { endStep(); startStep() },
    close() {
      endStep(); startStep()
      log('assistant/message', { turn, step, stream: [], message: {
        id: `answer-${turn}`, role: 'assistant', source: { provider: 'test', model: 'test' },
        content: [{ type: 'text', text: 'Done' }],
      } }, 'append')
      endStep(); log('turn/end', { turn, reason: { kind: 'completed' } })
    },
    native(title: string, path = 'viz/a.html') {
      call(title, 'visualize', argsFor(title, path))
      result(title, metaFor(title, path))
    },
    ptc(rootCallId: string, cards: readonly { title: string; path?: string; failed?: boolean; parentCallId?: string }[]) {
      call(rootCallId, 'run_code', { code: '/* visualization calls */' })
      for (const { title, path = 'viz/a.html', failed = false, parentCallId = rootCallId } of cards) {
        const data = { rootCallId, parentCallId, subCallId: title, name: 'visualize', arguments: argsFor(title, path) }
        log('tool/ptc-dispatch-start', data)
        log('tool/ptc-dispatch', { ...data, isError: failed, content: [], meta: metaFor(title, path) })
      }
      result(rootCallId)
    },
  }
}

function argsFor(title: string, path: string) {
  return title === 'A1' || title === 'B'
    ? { title, fragment: `<p>${title}</p>` }
    : { action: 'update', title, path, old_str: '<p>', new_str: '<div>' }
}

function metaFor(title: string, path: string) {
  return { kind: 'visualize', title, path, fragment: `<p>${title}</p>`, mode: 'inline', style: 'whale' }
}

describe.skipIf(!hasHostSource)('turn cards in the DSH source Conversation engine', () => {
  let createAssembler: () => ConversationNodeAssembler
  let mount: ReturnType<typeof createRoot> | undefined
  let element: HTMLDivElement

  beforeAll(async () => {
    const fromSource = (path: string) => import(/* @vite-ignore */ `/@fs${resolve(client, path)}`)
    const { ConversationNodeAssembler: Assembler } = await fromSource('ui-conversation/src/client/conversation/assembler.ts')
    const { chatViewDefinition } = await fromSource('ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts')
    const { turnTailDefinition } = await fromSource('ui-chat/src/client/conversation-nodes/turn-tail.ts')
    const { assistantDefinition } = await fromSource('ui-chat/src/client/conversation-nodes/assistant.ts')
    const { toolDefinition } = await fromSource('ui-chat/src/client/conversation-nodes/tool.ts')
    createAssembler = () => new Assembler({
      entries: () => [cardResultDefinition, turnCardsDefinition, turnTailDefinition, assistantDefinition, toolDefinition],
      fallbackEntry: () => undefined,
    }, { entries: () => [chatViewDefinition] })
    window.matchMedia ??= (() => ({ addEventListener() {}, removeEventListener() {} })) as never
  })

  afterEach(() => {
    if (mount !== undefined) act(() => mount?.unmount())
    mount = undefined
    element?.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function assemble(events: readonly Entry[], feed: 'append' | 'replay' | 'prepend') {
    const engine = createAssembler()
    engine.activateTarget('chat')
    if (feed === 'append') {
      for (const event of events) {
        engine.append(event as never)
        engine.flush()
      }
    } else if (feed === 'prepend') {
      const cut = events.findIndex(({ event }) => event.type === 'tool/ptc-dispatch')
      engine.replaceWindow(events.slice(cut) as never, true)
      engine.flush()
      engine.prepend(events.slice(0, cut) as never, false)
      engine.flush()
    } else {
      engine.replaceWindow(events as never, false)
      engine.flush()
    }
    return engine.get('chat')!
  }

  function tailOwner(chat: ChatSnapshot, turn: number) {
    const tail = chat.nodes.values().find(node => node.kind === 'turn-tail'
      && (node as ChatNode<'turn-tail'>).data.turn === turn) as ChatNode<'turn-tail'>
    if (tail.location.kind !== 'turn' && tail.location.kind !== 'step') throw new Error('Missing tail location')
    if (tail.data.closing === null) throw new Error('Missing closing reply')
    return { turn: tail.location.turn, seq: tail.data.closing.finalNode.seq }
  }

  function render(chat: ChatSnapshot, process?: ToolCallBlock, turn = 1) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    element ??= document.createElement('div')
    document.body.append(element)
    mount ??= createRoot(element)
    const useChat: UseChat = pick => pick(chat)
    const childCards = process !== undefined && 'kind' in process ? process.subCalls : []
    act(() => mount?.render(<>
      <div data-process>
        {childCards.map(block => <Card key={block.callId} callId={block.callId} block={block} useChat={useChat} useDisclosure={useDisclosure} />)}
      </div>
      <div data-tail><Tail {...tailOwner(chat, turn)} useChat={useChat}
        useVisualizeFolds={(pick: (folds: boolean) => boolean) => pick(true)} /></div>
    </>))
  }

  /** Render every settled tool-call row of a Turn the way an expanded process shows it. */
  function renderProcessRows(chat: ChatSnapshot) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    element ??= document.createElement('div')
    document.body.append(element)
    mount ??= createRoot(element)
    const useChat: UseChat = pick => pick(chat)
    const roots = chat.nodes.values().filter(node => node.kind === 'tool-call')
      .map(node => (node as ChatNode<'tool-call'>).data.root)
    const blocks = roots.flatMap(block => 'kind' in block && block.subCalls.length > 0 ? block.subCalls : [block])
    act(() => mount?.render(<div data-process>
      {blocks.map(block => <Card key={block.callId} callId={block.callId} block={block} useChat={useChat} useDisclosure={useDisclosure} />)}
    </div>))
  }

  it.each([
    ['native calls', (h: ReturnType<typeof history>) => {
      h.native('A1'); h.nextStep(); h.native('A2'); h.nextStep(); h.native('A3')
    }],
    ['PTC calls across two roots', (h: ReturnType<typeof history>) => {
      h.ptc('root-1', [{ title: 'A1' }, { title: 'A2' }]); h.nextStep(); h.ptc('root-2', [{ title: 'A3' }])
    }],
    ['a native call superseded by a PTC call', (h: ReturnType<typeof history>) => {
      h.native('A1'); h.nextStep(); h.ptc('root', [{ title: 'A2' }, { title: 'A3' }])
    }],
  ] as const)('collapses earlier versions of %s in an expanded process', (_name, write) => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as never)
    const log = history()
    log.start(); write(log); log.close()
    renderProcessRows(assemble(log.events, 'replay'))
    expect(frames('process')).toEqual(['A3'])
    expect(earlierRows().map(row => row.textContent?.split(' · ').at(-1))).toEqual(['A1', 'A2'])
    expect(earlierRows().map(row => row.getAttribute('aria-expanded'))).toEqual(['false', 'false'])
  })

  it('keeps a card from an earlier Turn whole when a later Turn updates it', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as never)
    const log = history()
    log.start(); log.native('A1'); log.close()
    log.start(); log.native('A2'); log.close()
    renderProcessRows(assemble(log.events, 'replay'))
    expect(frames('process')).toEqual(['A1', 'A2'])
    expect(earlierRows()).toHaveLength(0)
  })

  function earlierRows() {
    return [...element.querySelectorAll<HTMLElement>('[role="button"][aria-expanded]')]
  }

  function frames(where = 'tail') {
    return [...element.querySelectorAll<HTMLIFrameElement>(`[data-${where}] iframe`)].map(frame => frame.title)
  }

  const cases = [
    ['native create and two updates', (h: ReturnType<typeof history>) => {
      h.native('A1'); h.nextStep(); h.native('A2'); h.nextStep(); h.native('A3')
    }, ['A3']],
    ['PTC create and two updates in one root', (h: ReturnType<typeof history>) => {
      h.ptc('root', [{ title: 'A1' }, { title: 'A2' }, { title: 'A3' }])
    }, ['A3']],
    ['PTC updates across two roots', (h: ReturnType<typeof history>) => {
      h.ptc('root-1', [{ title: 'A1' }, { title: 'A2' }]); h.nextStep(); h.ptc('root-2', [{ title: 'A3' }])
    }, ['A3']],
    ['native result overwrites a PTC result without moving its path', (h: ReturnType<typeof history>) => {
      h.ptc('root', [{ title: 'A1' }, { title: 'B', path: 'viz/b.html' }]); h.nextStep(); h.native('A2')
    }, ['A2', 'B']],
    ['PTC result overwrites a native result', (h: ReturnType<typeof history>) => {
      h.native('A1'); h.nextStep(); h.ptc('root', [{ title: 'A2' }])
    }, ['A2']],
    ['two paths preserve their first appearance order', (h: ReturnType<typeof history>) => {
      h.ptc('root', [{ title: 'A1' }, { title: 'B', path: 'viz/b.html' }, { title: 'A2' }])
    }, ['A2', 'B']],
  ] as const

  it.each(cases)('%s shows the expected tail on append and replay', (_name, write, expected) => {
    const log = history()
    log.start(); write(log); log.close()
    for (const feed of ['append', 'replay'] as const) {
      render(assemble(log.events, feed))
      expect(frames(), feed).toEqual(expected)
    }
  })

  it('resolves dispatches when an older history page supplies their missing coordinates, without leaking across turns', () => {
    const log = history()
    log.start(); log.ptc('first-root', [{ title: 'A1' }]); log.close()
    log.start(); log.ptc('second-root', [{ title: 'A2' }]); log.close()
    const chat = assemble(log.events, 'prepend')
    render(chat)
    expect(frames()).toEqual(['A1'])
    render(chat, undefined, 2)
    expect(frames()).toEqual(['A2'])
  })

  it('keeps one final frame and mounts historical snapshots on demand', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as never)
    const log = history()
    log.start()
    log.ptc('root', [{ title: 'A1' }, { title: 'A2' }, { title: 'A3' }, { title: 'failed', failed: true }])
    log.close()
    const chat = assemble(log.events, 'replay')
    const row = chat.nodes.values().find(node => node.kind === 'tool-call') as ChatNode<'tool-call'>
    render(chat, row.data.root)
    expect(frames('process')).toEqual(['A3'])
    const [first, second] = earlierRows()
    expect(earlierRows()).toHaveLength(2)
    expect(frames()).toEqual([])

    act(() => first!.click())
    expect(first!.getAttribute('aria-expanded')).toBe('true')
    expect(second!.getAttribute('aria-expanded')).toBe('false')
    expect(frames('process')).toEqual(['A1', 'A3'])
    expect(element.querySelector('iframe[title="A1"]')?.getAttribute('srcdoc')).toContain('<p>A1</p>')
    expect(first!.tabIndex).toBe(0)
    act(() => first!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(first!.getAttribute('aria-expanded')).toBe('false')
    expect(frames('process')).toEqual(['A3'])

    const process = element.querySelector('[data-process]')!
    await act(async () => { process.setAttribute('hidden', 'until-found') })
    expect(frames()).toEqual(['A3'])
    await act(async () => { process.removeAttribute('hidden') })
    expect(frames()).toEqual([])
  })
})
