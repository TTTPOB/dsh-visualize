# Conversation integration tests

`ptc-turn-cards.spec.tsx` loads the real client Conversation assembler and Chat snapshot builder from a DSH source checkout with its dependencies already installed. It runs in jsdom without starting a DSH Host. A sibling `../deepseek-harness` checkout is detected automatically; override it with `DSH_HOST_SOURCE` to require a particular checkout. A standalone plugin checkout without a sibling skips this suite.

```sh
NODE_OPTIONS=--max-old-space-size=4096 DSH_HOST_SOURCE=../deepseek-harness pnpm test tests/ptc-turn-cards.spec.tsx
```
