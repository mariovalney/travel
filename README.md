# Travel PWA - notas de deploy

## Cache do Service Worker

Sempre que houver alteracoes em arquivos servidos pelo PWA (principalmente `public/index.html`, `public/sw.js`, manifest, icones, scripts e CSS), incremente a constante `CACHE` em `public/sw.js`.

Exemplo:

```js
const CACHE = 'bue-2026-v42';
```

Sem esse bump, usuarios com app instalado podem continuar presos no cache antigo e nao receber as mudancas, porque no PWA nao existe um fluxo simples de "limpar cache" para o usuario final.

## Checklist rapido antes de publicar

1. Alterou assets do PWA? -> bump de `CACHE` em `public/sw.js`.
2. Publicou backend/frontend.
3. Validou no dispositivo com PWA instalado (abrir app e conferir se atualizou).
