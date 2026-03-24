# Prompt: Crie um app de roteiro de viagem em grupo (PWA)

Use este prompt para criar do zero um aplicativo de roteiro de viagem compartilhado, igual ao que está neste repositório, mas para qualquer viagem.

---

## Antes de começar, preciso que você me informe:

### Dados da viagem

1. **Cidade/destino** (ex.: "Roma", "Buenos Aires", "Tokyo")
2. **Datas da viagem** — dia de ida e dia de volta (ex.: 15/06/2026 a 20/06/2026)
3. **Fuso horário do destino** (ex.: "Europe/Rome", "America/Argentina/Buenos_Aires")
4. **Fuso horário de origem** (ex.: "America/Sao_Paulo")

### Voos

5. **Voo de ida** — horário de partida, aeroporto de origem (código + cidade), horário de chegada, aeroporto de destino (código + cidade)
6. **Voo de volta** — mesma estrutura

### Hospedagem

7. **Endereço da hospedagem** (ex.: "Via del Corso 123, Roma")
8. **Coordenadas da hospedagem** (latitude, longitude)
9. **Nome/tipo** (ex.: "Airbnb", "Hotel", "Hostel")

### Grupo

10. **Quantas pessoas** no grupo (usado na divisão do câmbio e na lista de amigos)
11. **Lista de e-mails autorizados** (quem pode acessar o app) — um por linha
12. **Nome de exibição** de cada pessoa (associado ao e-mail)

### Identidade visual

13. **Título do app** (ex.: "Roteiro Roma", "Trip Tokyo 2026")
14. **Título curto** para o PWA (ex.: "Roma 2026")
15. **Slogan/frase** do grupo (aparece como destaque, ex.: "é nois", "bora!", "let's go")
16. **Cor principal** (hex, ex.: #3a8fd4)
17. **Cor secundária/accent** (hex, ex.: #74acdf)

### Domínio e deploy

18. **URL de produção** (ex.: "https://roma.meudominio.com")
19. **Provedores de login** — Google, Microsoft ou ambos?

### Câmbio (opcional)

20. **Moeda do destino** (código, ex.: "EUR", "ARS", "JPY") — se quiser a calculadora de câmbio
21. **Moeda de origem** (código, ex.: "BRL")

### Eventos iniciais (opcional)

22. Se já tiver um roteiro prévio, liste os eventos por dia com: título, horário, descrição (opcional), endereço (opcional)

---

## O que o app faz

### Funcionalidades principais

- **PWA instalável** com suporte offline — funciona como app nativo no celular
- **Roteiro por dia** — cada dia da viagem é uma aba com timeline de eventos
- **Eventos editáveis** — título, descrição, link, horário, duração, endereço (com autocomplete Google Places), tags coloridas, fotos, arquivos anexos
- **Autosave** — salva automaticamente ao editar
- **Detalhes do evento** — mapa "como chegar" com rota do evento anterior, galeria de fotos, download de arquivos
- **Notificações push** — ao criar/editar um evento, opção de notificar o grupo; o toque na notificação abre o evento específico
- **Aba Informações** — perfil do usuário, calculadora de câmbio, endereço da hospedagem com link para Maps, mapa de localização dos amigos em tempo real
- **Compartilhamento de localização** — cada pessoa pode compartilhar sua posição; mapa mostra todos do grupo
- **Cards de voo** — exibe voos de ida e volta nos dias correspondentes
- **Countdown** — barra de status com contagem regressiva até a viagem
- **Login social** — Google e/ou Microsoft OAuth; lista de e-mails autorizados
- **Atualização automática do PWA** — checa novas versões ao abrir, ao voltar à aba e a cada hora

### Permissões e hierarquia

- **Sem papéis de admin**: todos os membros autorizados podem criar, editar e deletar qualquer evento.
- O acesso é controlado pela lista `ALLOWED_EMAILS` no servidor; qualquer e-mail fora dela é rejeitado no login.

### Comportamento offline

- **Leitura offline**: o roteiro inteiro (timeline, detalhes, fotos já carregadas) fica disponível sem conexão via cache do service worker. O app armazena os eventos em `localStorage` para exibição imediata.
- **Edição é online-only**: criação, edição e upload de fotos/arquivos requerem conexão. Se estiver offline, o app exibe uma barra informando a falta de conexão.
- **Não há fila de sync**: quando a conexão volta, o usuário precisa refazer a ação manualmente. Isso simplifica bastante a implementação.

### Mapa de localização dos amigos

- **Polling via API**: o frontend consulta `GET /api/friends/locations` a cada 60 segundos enquanto a aba Informações estiver visível.
- **Envio de posição**: `POST /api/me/location` é chamado quando o usuário abre a aba ou quando a posição muda significativamente. Usa `navigator.geolocation.getCurrentPosition`.
- **Snap de país de origem**: se o usuário estiver no país de origem (bounding box), grava as coordenadas do aeroporto de origem em vez das reais (privacidade pré-viagem).
- **Membro offline ou sem compartilhamento**: exibir o marcador com a última posição conhecida e horário (ex.: "há 2h"). Se nunca compartilhou, não aparece no mapa.
- **Toggle**: cada pessoa pode ativar/desativar o compartilhamento em `/api/me/preferences`.

### Tratamento de erros e estados

- **Loading**: ao abrir o app, os eventos são carregados do `localStorage` imediatamente e atualizados com a API em background. Mostrar skeleton/placeholder se não houver cache local.
- **Erro de API**: exibir um toast (mensagem temporária) com a descrição do erro — nunca falhar silenciosamente.
- **Upload excede limite**: toast "Arquivo excede o tamanho máximo" com o limite em MB.
- **API de câmbio indisponível**: exibir último valor cacheado em `localStorage` com aviso "(valor de X horas atrás)" ou mensagem "Câmbio indisponível" se nunca foi carregado.
- **Falha no login**: redireciona para `/login?erro=1`; a página de login exibe "E-mail não autorizado".

---

## Stack técnica

- **Backend**: Node.js (>=18), Express, Mongoose (MongoDB), Passport (Google/Microsoft OAuth), express-session com connect-mongo (sessões persistentes em produção), multer (uploads), web-push
- **Frontend**: HTML/CSS/JS puro (single-page), sem framework, separado em `index.html` + `styles.css` + `app.js`
- **Banco**: MongoDB (ou mongodb-memory-server para dev local sem MongoDB)
- **APIs externas**: Google Maps JavaScript API (mapas e autocomplete), AwesomeAPI (câmbio)

### Sessões em produção

Usar `connect-mongo` como session store para que as sessões sobrevivam a restarts do processo:

```js
const MongoStore = require('connect-mongo');
app.use(session({
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  // ...
}));
```

Em desenvolvimento (sem `MONGODB_URI`), o session store padrão em memória é suficiente.

---

## Estrutura de arquivos

```
├── public/
│   ├── index.html          # App principal (estrutura e markup)
│   ├── styles.css          # Estilos globais
│   ├── app.js              # Lógica cliente
│   ├── login.html          # Página de login
│   ├── manifest.json       # PWA manifest
│   ├── sw.js               # Service Worker (precache + push)
│   ├── favicon.ico         # Favicon
│   ├── favicon.png         # Favicon PNG (badge do push)
│   ├── favicon-32x32.png   # Ícone 32x32
│   ├── favicon-16x16.png   # Ícone 16x16
│   ├── apple-touch-icon.png # Ícone iOS (180x180)
│   ├── android-chrome-192x192.png
│   ├── android-chrome-512x512.png
│   ├── icon-192.png        # Ícone push notification
│   ├── icon-512.png        # Ícone splash screen
│   └── ogimage.png         # Open Graph image (1200x630)
├── src/
│   ├── server.js           # Servidor Express + rotas + auth + API
│   └── models/
│       ├── Event.js         # Schema do evento
│       ├── User.js          # Schema do usuário
│       └── PushSubscription.js
├── uploads/                # Fotos e arquivos enviados (criado automaticamente)
├── .env                    # Variáveis de ambiente (não commitado)
├── .env.sample             # Template do .env com instruções
├── package.json
└── README.md               # Setup local, deploy, geração de chaves
```

### Nota sobre arquivos grandes

Nao use `index.html` monolitico com CSS/JS inline para este projeto. Mantenha sempre separado em:

- `public/index.html` (markup)
- `public/styles.css` (estilos)
- `public/app.js` (scripts)

Se a IA estiver gerando arquivos grandes, gere por blocos e confirme que nenhum arquivo foi truncado.

### Ícones PWA

Gerar todos os ícones referenciados no `manifest.json` e no HTML. Use uma imagem base quadrada (512x512 ou maior) e redimensione para cada tamanho. Os arquivos devem existir fisicamente em `public/`:

| Arquivo | Tamanho | Uso |
|---------|---------|-----|
| `favicon.ico` | 32x32 | Browser tab |
| `favicon.png` | 32x32 | Badge push |
| `favicon-16x16.png` | 16x16 | Browser tab |
| `favicon-32x32.png` | 32x32 | Browser tab |
| `apple-touch-icon.png` | 180x180 | iOS home screen |
| `icon-192.png` | 192x192 | Push notification icon |
| `icon-512.png` | 512x512 | Splash screen |
| `android-chrome-192x192.png` | 192x192 | Android home screen |
| `android-chrome-512x512.png` | 512x512 | Android splash / maskable |
| `ogimage.png` | 1200x630 | Open Graph / Twitter Card |

---

## Variáveis de ambiente (.env)

```env
NODE_ENV=development

# URL pública de produção (ex.: https://roma.meudominio.com)
# Google OAuth redirect: <URL>/auth/google/callback
CALLBACK_URL=""

# Microsoft OAuth — Azure App Registration
# Redirect: <URL>/auth/microsoft/callback
MICROSOFT_CLIENT_ID=""
MICROSOFT_CLIENT_SECRET=""
MICROSOFT_CALLBACK_URL=""

# Sessão (gerar string aleatória longa)
SESSION_SECRET=""

# Google OAuth — Google Cloud Console > APIs & Services > Credentials
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
GOOGLE_MAPS_API_KEY=""

# API de câmbio (opcional)
AWESOME_API_KEY=""

# MongoDB — string de conexão com nome do banco no path
# ex.: mongodb+srv://user:pass@cluster.xxx.mongodb.net/nome-do-banco?authSource=admin
MONGODB_URI=""

# Push — gerar com: node -e "const w=require('web-push'); const k=w.generateVAPIDKeys(); console.log(JSON.stringify(k))"
VAPID_PUBLIC_KEY=""
VAPID_PRIVATE_KEY=""
```

---

## Fases de geração (obrigatório)

Implemente em fases, validando antes de seguir para a próxima:

1. Criar `package.json` e instalar dependências.
2. Criar models (`Event.js`, `User.js`, `PushSubscription.js`).
3. Implementar `src/server.js` (auth, sessão, APIs, uploads, seed).
4. Criar `public/index.html` (somente markup).
5. Criar `public/styles.css`.
6. Criar `public/app.js`.
7. Criar `public/login.html`.
8. Criar `public/manifest.json` e `public/sw.js`.
9. Criar `.env.sample`.
10. Criar `README.md` completo.

Checklist mínimo por fase:

- Rodar `node --check src/server.js` quando mexer no backend.
- Rodar `node --check public/app.js` quando mexer no frontend JS.
- Garantir que os caminhos de assets em HTML/SW sejam absolutos (`/arquivo`).
- Garantir bump de `CACHE` no `sw.js` a cada mudança em assets PWA.

---

## Contrato de API (nao inventar endpoints)

Use exatamente estes endpoints:

- `GET /api/events` - listar eventos
- `POST /api/events` - criar evento
- `PUT /api/events/:id` - atualizar evento
- `DELETE /api/events/:id` - remover evento
- `POST /api/events/:id/photos` - upload de fotos
- `DELETE /api/events/:id/photos/:filename` - remover foto
- `POST /api/events/:id/files` - upload de arquivos
- `DELETE /api/events/:id/files/:filename` - remover arquivo
- `GET /api/me` - perfil do usuário autenticado
- `PATCH /api/me/preferences` - preferências (ex.: compartilhar localização)
- `POST /api/me/location` - atualizar localização atual
- `GET /api/friends/locations` - listar localização do grupo
- `GET /api/fx/:pair` - cotação (ex.: `ars-brl`)
- `GET /api/config` - configuração pública do app
- `GET /api/push/vapid-key` - chave pública VAPID
- `POST /api/push/subscribe` - registrar subscription push
- `GET /api/auth/providers` - provedores de login habilitados

---

## Detalhes de implementação

### Service Worker (`sw.js`)

- **Precache**: lista de assets do shell (`index.html`, `manifest.json`, ícones, fontes) cacheados no `install`.
- **Estratégia**: cache-first para assets precacheados; rotas `/api/` e `/uploads/` nunca cacheados (passam direto para a rede).
- **Atualização**: `skipWaiting()` no `install` + `clients.claim()` no `activate` para atualização imediata.
- **Push**: recebe payload `{ title, body, eventId }`, monta URL `/e/<eventId>`, armazena em `notification.data`.
- **Click na notificação**: foca janela existente do app e navega para a URL, ou abre nova janela se não houver.
- **Cache bump obrigatório**: incrementar a constante `CACHE` (ex.: `v1` -> `v2`) a cada mudança em assets servidos pelo PWA. Sem isso, apps instalados ficam presos na versão antiga.

### Rotas SPA

O servidor retorna `index.html` para todas as rotas de navegação: `/`, `/dia-1`, `/dia-2`, ..., `/info`, `/e/:id`, `/e/:id/editar`, `/login`. O roteamento real é feito no client via `history.pushState` + `popstate`.

### Schema de eventos

```js
{
  day:             Number,    // 0-based (0 = primeiro dia da viagem)
  order:           Number,    // ordenação dentro do dia
  isoTime:         String,    // data/hora ISO com timezone (ex.: "2026-06-15T10:00:00+02:00")
  title:           String,    // obrigatório
  description:     String,
  link:            String,    // URL opcional
  location: {
    address: String,
    lat:     Number,
    lng:     Number,
  },
  durationMinutes: Number,
  tags:            [{ label: String, style: 'default' | 'dark' | 'red' }],
  photos:          [String],  // filenames em /uploads/
  files:           [String],  // filenames em /uploads/
}
```

### Uploads

- Multer salva em `uploads/` com nome único (timestamp + random + extensão original).
- Servido via `express.static`.
- **Limite**: 10 MB por arquivo (fotos); ajustar se necessário para arquivos genéricos.
- **Tipos aceitos**: fotos aceitam apenas `image/*` no input; arquivos aceitam qualquer tipo.
- **Cleanup**: ao deletar um evento, remover todos os arquivos associados (`photos` + `files`) do disco.
- **Validação no servidor**: rejeitar com 413 se multer atingir o limite; retornar erro claro no JSON.

### Fluxos críticos (pseudocódigo)

#### Autosave de evento

```text
autosave():
  data = buildEditPayload(form)
  if data invalido -> mostrar toast e retornar

  if currentEventId existe:
    updated = PUT /api/events/:id
  else:
    updated = POST /api/events
    currentEventId = updated._id

  mergeEventIntoCache(updated)
  uploadPendingPhotosIfAny()
  uploadPendingFilesIfAny()
  renderAllTimelines()
```

#### Registro e atualização do Service Worker

```text
registerSW():
  reg = navigator.serviceWorker.register('/sw.js')
  marcar pendingReload quando updatefound/installing -> installed com controller ativo
  no controllerchange:
    se pendingReload -> location.reload()

  chamar reg.update():
    - ao carregar
    - a cada 60 minutos
    - quando aba volta para visible
```

#### Push: clique abre evento

```text
server notify payload:
  { title, body, eventId }

sw push:
  url = eventId ? '/e/' + eventId : '/'
  showNotification(..., data: { url })

sw notificationclick:
  foco janela existente do app e navega para url
  senão abre nova janela em url
```

### Localização dos amigos

- `POST /api/me/location` — recebe `{ lat, lng }` e salva no `User`.
- `GET /api/friends/locations` — retorna posição de todos que compartilham.
- Se o usuário estiver dentro do bounding box do país de origem, grava coordenadas do aeroporto de origem (privacidade pré-viagem).
- Polling a cada 60 segundos na aba Informações.

### Calculadora de câmbio

- O servidor consulta a API externa e expõe via `GET /api/fx/{par}` (ex.: `/api/fx/ars-brl`).
- O frontend exibe o valor unitário e divide o montante pelo número de pessoas do grupo.
- Cachear último valor em `localStorage`; se a API falhar, exibir valor cacheado com aviso.

### Registro do Service Worker (client)

O `index.html` deve registrar o SW e checar atualizações periodicamente:

- `reg.update()` ao carregar, ao voltar à aba (`visibilitychange`), e a cada 60 minutos.
- Ao detectar nova versão instalada (via `updatefound` + `statechange` = `installed` com controller ativo), recarregar a página no `controllerchange`.
- Evitar reload na primeira ativação (flag `pendingReload` só fica true quando já existe um controller e uma nova versão foi instalada).

---

## README esperado

O README gerado deve conter:

1. **O que é o app** — descrição curta
2. **Setup local** — `npm install`, criar `.env` a partir do `.env.sample`, rodar `npm start`
3. **MongoDB** — como rodar local (Docker ou Atlas free tier); em dev sem MongoDB usa `mongodb-memory-server` automaticamente
4. **Geração das chaves VAPID** — o comando `node -e "..."` que gera o par de chaves
5. **Configuração do Google OAuth** — passos no Google Cloud Console (criar projeto, habilitar API, criar credenciais OAuth, adicionar redirect URI)
6. **Configuração do Microsoft OAuth** — passos no Azure Portal (App Registration, redirect URI, client secret, tipo de conta pessoal+org)
7. **Google Maps API Key** — como habilitar Maps JavaScript API e Places API no console
8. **Deploy** — instruções mínimas (variáveis de ambiente, MongoDB Atlas, domínio, HTTPS)
9. **Cache do PWA** — lembrete de sempre incrementar `CACHE` em `sw.js` ao publicar mudanças
