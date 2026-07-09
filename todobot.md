# N1 NEXUS VIP — Análisis Completo del Bot WhatsApp

## Infraestructura General

El sistema es un **bot de WhatsApp profesional** para "Agencia Nexus" (N1 NEXUS VIP) que funciona en hosting compartido de Hostinger. Combina una API de WhatsApp en tiempo real con una inteligencia artificial (Mistral) y un panel web de administración con diseño glassmorphism.

**Stack tecnológico:**
- **Runtime:** Node.js v20+ (sin navegador, sin Puppeteer)
- **WhatsApp API:** @whiskeysockets/baileys v7.0.0-rc13 (conexión directa a WhatsApp Web)
- **IA:** Mistral AI (modelo `mistral-tiny`, hasta 300 tokens)
- **Servidor web:** Express v5 + Socket.IO v4 (tiempo real)
- **Hosting:** Hostinger compartido (Linux, sin root)
- **Puerto:** 3000

---

## Arquitectura del Sistema

```
┌─────────────────────────────────────────────────────────────┐
│                    SERVIDOR (server.js)                       │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │   Baileys     │  │  Mistral AI  │  │  Socket.IO       │   │
│  │  WhatsApp     │  │  (LLM)       │  │  (WebSocket)     │   │
│  │  Connection   │  │              │  │                  │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         │                  │                    │              │
│         ▼                  ▼                    ▼              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              PIPELINE DE MENSAJES                     │    │
│  │                                                       │    │
│  │  WhatsApp → resolveNumber() → getMistralReply()      │    │
│  │  → sock.sendMessage() → addToHistory()               │    │
│  │  → upsertContact() → io.emit('new-message')         │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              ARCHIVOS DE DATOS (JSON)                 │    │
│  │                                                       │    │
│  │  conversations.json (247KB, 643 mensajes)            │    │
│  │  contacts.json (5KB, 11 contactos)                   │    │
│  │  bot-knowledge.json (18KB, base de conocimiento)     │    │
│  │  database/settings.json (configuración)              │    │
│  │  database/saved-contacts.json (contactos guardados)  │    │
│  │  database/predefined-texts.json (textos rápidos)     │    │
│  │  database/call-log.json (registro de llamadas)       │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              SEGURIDAD Y LOCKS                        │    │
│  │                                                       │    │
│  │  .bot.lock (PID|TIMESTAMP, heartbeat cada 15s)       │    │
│  │  .deploy.marker (detecta nuevas instancias)          │    │
│  │  auth_info/ (credenciales Baileys)                   │    │
│  └──────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                          │
                          │ Socket.IO + Express
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              PANEL WEB (public/index.html)                   │
│              3513 líneas | HTML + CSS + JS                   │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  Contactos    │  │    Chat      │  │  Panel Derecho   │   │
│  │  (Grid horiz) │  │  (Mensajes)  │  │  (Textos préd.)  │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  QR Overlay   │  │  Sidebar     │  │  Modales         │   │
│  │  (Escaneo)    │  │  (Contactos) │  │  (CRUD)          │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Flujo de Mensajes (Detallado)

### Mensaje Entrante de WhatsApp

```
1. WhatsApp envía evento → messages.upsert
2. Filtro: solo mensajes privados (@c.us o @lid), no propios
3. resolveNumber(msg) → resuelve LID a número de teléfono
   - Intento 1: remoteJidAlt (si existe)
   - Intento 2: lidToPhoneMap (caché en memoria)
   - Intento 3: signalRepository.lidMapping.getPNForLID()
   - Fallback: usar LID como número
4. Extraer body del mensaje (texto, extendedText, botones, lista, o [multimedia])
5. Crear msgData: { id, type:'incoming', from, number, body, timestamp }
6. io.emit('new-message', msgData) → panel web actualización en tiempo real
7. Guardar en conversations[number] (máximo 300 mensajes)
8. upsertContact() → actualizar contacto (lastMessage, unreadCount++)
9. addToHistory(number, 'user', body) → contexto para Mistral (máximo 50)
10. getMistralReply(body, number) → llamada a Mistral API
    - Construye system prompt con bot-knowledge.json (planes, FAQ, personalidad)
    - Incluye últimos 6 mensajes como contexto conversacional
    - Modelo: mistral-tiny, max_tokens: 300, timeout: 25s
11. Si Mistral falla → getAutoReply(body) → respuestas por keywords
12. Si hay respuesta → sock.sendMessage(from, { text: autoReply })
13. Guardar respuesta en conversations.json con type:'ai-reply'
14. io.emit('new-message', aiMsgData) → panel web muestra respuesta
15. upsertContact() → actualizar último mensaje del contacto
```

### Mensaje Manual del Operador

```
1. Operador escribe en el panel web
2. socket.emit('send-message', { number, message, name })
3. sock.sendMessage(toChatId(number), { text: message })
4. Guardar en conversations[number] con type:'manual', from:'Tu'
5. io.emit('new-message', msgData)
6. upsertContact() → actualizar último mensaje
```

### Borrador del Operador (Operador + IA)

```
1. Operador abre borrador con último mensaje del usuario
2. Escribe su respuesta (borrador)
3. Mistral AI refine el borrador con el contexto del usuario
4. sock.sendMessage() con el texto refinado
5. Guardar con type:'operator-ai', from:'Operador + IA'
6. io.emit('new-message', msgData)
```

### Envío de Archivos

```
1. Operador adjunta archivo (imagen/audio/video/documento, máx 16MB)
2. Se convierte a base64 y se envía vía socket.emit('send-media')
3. Server decodifica base64 y rutea según mimetype:
   - image/* → msgPayload.image
   - audio/* → msgPayload.audio
   - video/* → msgPayload.video
   - otro → msgPayload.document con fileName
4. sock.sendMessage() con el payload
5. Guardar en conversations con type:'manual', body: '[filename]'
```

---

## Funciones del Backend (server.js — 978 líneas)

### Funciones Principales

| Función | Línea | Propósito |
|---------|-------|-----------|
| `startBot()` | 737 | Inicializa Baileys, conexión WhatsApp, eventos |
| `getMistralReply(message, number)` | 275 | Llama a Mistral AI para generar respuesta |
| `getAutoReply(message)` | 143 | Respuestas por keywords (fallback) |
| `buildSystemPrompt()` | 249 | Construye el prompt del sistema con knowledge base |
| `addToHistory(number, role, body)` | 69 | Guarda en historial conversacional (máx 50) |
| `getHistory(number, lastN)` | 76 | Obtiene últimos N mensajes del historial |
| `resolveNumber(msg)` | 101 | Resuelve LID → número de teléfono |
| `normalizeNumber(value)` | 81 | Normaliza números WhatsApp |
| `toChatId(number)` | 87 | Convierte número a JID de WhatsApp |
| `upsertContact()` | 188 | Crea/actualiza contacto en memoria |
| `emitContacts()` | 197 | Emite contactos a todos los clientes web |
| `createMessageId()` | 97 | Genera IDs únicos para mensajes |
| `log(msg)` | 20 | Logging circular (máx 200 líneas) |

### Funciones de Seguridad

| Función | Línea | Propósito |
|---------|-------|-----------|
| `acquireLock()` | 653 | Adquiere lock file (evita instancias duplicadas) |
| `heartbeatLock()` | 686 | Actualiza timestamp del lock cada 15s |
| `releaseLock()` | 698 | Libera el lock (solo si es nuestra PID) |
| `writeDeployMarker()` | 708 | Escribe marcador de deploy |
| `checkDeployMarker()` | 712 | Detecta si otra instancia se deployó |
| `clearDeployMarker()` | 729 | Borra marcador después de conexión exitosa |

### Rutas Express

| Método | Ruta | Propósito |
|--------|------|-----------|
| GET | `/` | Sirve el panel web (index.html) |
| GET | `/status` | Estado del sistema (Node, uptime, memoria, WA) |
| GET | `/api/saved-contacts` | Lista contactos guardados |
| POST | `/api/saved-contacts` | Crear contacto guardado |
| PUT | `/api/saved-contacts/:id` | Actualizar contacto guardado |
| DELETE | `/api/saved-contacts/:id` | Eliminar contacto guardado |
| GET | `/api/predefined-texts` | Lista textos predefinidos |
| POST | `/api/predefined-texts` | Crear texto predefinido |
| PUT | `/api/predefined-texts/:id` | Actualizar texto predefinido |
| DELETE | `/api/predefined-texts/:id` | Eliminar texto predefinido |
| GET | `/api/settings` | Obtener configuración |
| PUT | `/api/settings` | Actualizar configuración |
| GET | `/api/conversations` | Obtener todas las conversaciones |
| GET | `/api/conversations/:number` | Obtener conversación específica |
| DELETE | `/api/conversations/:number` | Eliminar conversación |
| POST | `/api/disconnect` | Desconectar WhatsApp + reiniciar bot |
| POST | `/api/restart` | Reiniciar bot |

### Eventos Socket.IO (Backend)

| Evento | Dirección | Propósito |
|--------|-----------|-----------|
| `connection` | Server recibe | Envía estado inicial (status, contacts, conversations, qr) |
| `disconnect` | Server recibe | Log de desconexión del cliente |
| `mark-read` | Server recibe | Marca contacto como leído |
| `toggle-read-status` | Server recibe | Alterna estado leído/no leído |
| `update-contact-notes` | Server recibe | Actualiza notas del contacto |
| `set-bot-enabled` | Server recibe | Activa/desactiva bot por contacto |
| `add-contact` | Server recibe | Agrega contacto manualmente |
| `delete-chat` | Server recibe | Elimina conversación + contacto |
| `submit-operator-draft` | Server recibe | Refina borrador con IA y envía |
| `operator-inject-context` | Server recibe | Inyecta contexto al operador (no implementado) |
| `send-message` | Server recibe | Envía mensaje de texto manual |
| `send-media` | Server recibe | Envía archivo multimedia |
| `get-call-log` | Server recibe | Devuelve registro de llamadas |
| `clear-call-log` | Server recibe | Limpia registro de llamadas |
| `status` | Server envía | Estado de conexión WhatsApp |
| `contacts` | Server envía | Lista de contactos actualizada |
| `conversations` | Server envía | Todas las conversaciones |
| `qr-code` | Server envía | Código QR en base64 |
| `new-message` | Server envía | Nuevo mensaje individual |
| `send-result` | Server envía | Resultado de operación de envío |

---

## Funciones del Frontend (index.html — 3513 líneas)

### Diseño Visual
- **Estilo:** Glassmorphism (backdrop-filter, gradientes, transparencias)
- **Paleta:** Fondo oscuro #0a0e14, cyan #00d4ff, verde #00ff88, púrpura #a855f7
- **Grid:** Dashboard 2 columnas (chat + panel derecho), 3 filas (topbar, contenido, composer)
- **Responsive:** 3 breakpoints (1100px, 700px) — mobile-first con hamburger menu

### Componentes del Panel

#### Topbar
- Marca "N1 NEXUS VIP" con gradiente cyan→verde
- Badge de estado (conectado/desconectado/QR/error)
- Botones Desconectar y Reiniciar

#### Grid de Contactos (Horizontal)
- Tarjetas glassmorphism con avatar, nombre, número
- Badges: IA (activo), PAUSA (bot desactivado), GUARDADO (contacto guardado)
- Contador de mensajes no leídos (rojo)
- Notas del operador
- Búsqueda en tiempo real

#### Área de Chat
- Mensajes con estilos diferenciados:
  - **Entrante (verde):** Usuario de WhatsApp
  - **Manual (naranja→púrpura):** Operador
  - **IA (azul→índigo):** Respuesta automática del bot
  - **Operador+IA (púrpura→rosa):** Borrador refinado
  - **Sistema (cyan):** Notificaciones
  - **Error (rojo):** Errores
- Auto-scroll al último mensaje
- Timestamps formateados

#### Panel Derecho
- Lista de textos predefinidos con acciones:
  - Copiar, Editar, Eliminar, Refinar con IA
  - Tags y categorías
  - Conteo de uso

#### Composer
- Campo de teléfono (auto-con número seleccionado)
- Campo de mensaje
- Botones: Toggle bot, Borrador, Toggle leído, Eliminar chat, Adjuntar archivo, Enviar

#### QR Overlay
- Muestra código QR para escanear
- Countdown de 120 segundos
- Botón "Solicitar QR" cuando expira o hay error de sesión
- Se cierra automáticamente al conectar

#### Sidebar de Contactos
- 3 pestañas: Contactos, Llamadas, Configuración
- Búsqueda en tiempo real
- Badges y estados
- Registro de llamadas rechazadas
- Configuración del bot (modelo, tokens, llamadas)

### Funciones JavaScript Principales

| Función | Línea | Propósito |
|---------|-------|-----------|
| `renderContacts()` | 2480 | Renderiza tarjetas de contactos en el grid |
| `renderConversation()` | 2585 | Renderiza mensajes del chat seleccionado |
| `selectContact(number, name)` | 2647 | Selecciona contacto y carga conversación |
| `sendManualMessage()` | 2655 | Envía mensaje de texto |
| `sendPendingFile()` | 3081 | Envía archivo adjunto |
| `mergeMessage(msg)` | 2754 | Inserta mensaje nuevo en tiempo real |
| `openDraft()` | 2694 | Abre panel de borrador |
| `sendDraft()` | 2732 | Envía borrador refinado con IA |
| `loadPredefinedTexts()` | 2770 | Carga textos predefinidos |
| `renderPredefined()` | 2780 | Renderiza lista de textos |
| `loadSavedContacts()` | 2859 | Carga contactos guardados |
| `renderSidebarContacts()` | 3143 | Renderiza contactos en sidebar |
| `startQrCountdown()` | 3378 | Countdown de 120s para QR |
| `showQrOverlay(msg)` | 3408 | Muestra overlay de QR manualmente |
| `normalizeNumber(val)` | 2428 | Normaliza números |
| `escapeHtml(text)` | 2434 | Previene XSS |
| `formatTime(ts)` | 2442 | Formatea timestamps |
| `getInitials(name)` | 2447 | Obtiene iniciales del nombre |
| `getContactColor(name, num)` | 2452 | Color determinístico por contacto |
| `init()` | 3499 | Inicialización del panel |

### Eventos Socket.IO (Frontend)

| Evento | Línea | Propósito |
|--------|-------|-----------|
| `socket.on('status')` | 2940 | Actualiza badge de estado |
| `socket.on('contacts')` | 2957 | Reemplaza contactos, re-renderiza |
| `socket.on('conversations')` | 2620 | Reemplaza conversaciones |
| `socket.on('new-message')` | 2622 | Inserta mensaje nuevo |
| `socket.on('call-logged')` | 2626 | Actualiza registro de llamadas |
| `socket.on('send-result')` | 2631 | Muestra resultado de envío |
| `socket.on('qr-code')` | 2671 | Muestra/oculta QR |

---

## Base de Conocimiento (bot-knowledge.json)

### Personalidad del Bot — "NEXUS"
El bot tiene **doble personalidad** controlada por keywords:

1. **Modo COMERCIAL** — Cuando el usuario pregunta por precios, planes, servicios, demos, su negocio
   - Tono: Profesional, enérgico, orientado a resultados
   - Objetivo: Cerrar ventas, agendar demos

2. **Modo SABIDURÍA** — Cuando el usuario expresa tristeza, estrés, problemas familiares, preguntas existenciales
   - Tono: Cálido, paternal, empático
   - Objetivo: Consolar, dar perspectiva, guiar

### Catálogo de Planes (5 planes)

| Plan | Precio (COP) | Características Clave |
|------|-------------|----------------------|
| Essential | $290K (único pago) | Landing page, 5 secciones, formulario contacto |
| Start | $490K (único pago) | 10 secciones, tienda 20 productos, integración WhatsApp |
| PRO | $890K (único pago) | CMS, catálogo ilimitado, API WhatsApp, carrito |
| ENTERPRISE | $1.59M (único pago) | Facturación, CRM, roles/permisos, reportes Excel/PDF |
| DIAMANTE | $2.49M único o $249K/mes | 20 páginas, SEO, email marketing, manager dedicado |

### Frases de Sabiduría (30 frases, 10 temas)
Temas: estrés, familia, espiritual, fracaso, decisiones, soledad, éxito, cambio, pérdida, esperanza

### Ejemplos Comerciales (9 ejemplos)
Mapeo de tipos de negocio a planes recomendados (Spa, Ferreterías, Fotografía, etc.)

### FAQ (5 preguntas frecuentes)

### Procesos de Cierre (7 pasos comerciales, 6 pasos sabiduría)

---

## Datos Actuales del Sistema

### Contactos Activos (11)

| Nombre | Número | No Leídos | Bot | Notas |
|--------|--------|-----------|-----|-------|
| Rolo | 573145439411 | 0 | ✅ | saboresdelrolo.com |
| maryo | 573122186137 | 5 | ✅ | Saboresdelrolo.com |
| . | 573147471086 | 0 | ✅ | CARO AMOR |
| n1artisty | 573147473629 | 4 | ✅ | — |
| Enigma | 573022482928 | 1 | ✅ | — |
| Luz | 573146830756 | 1 | ✅ | — |
| Keller | 573001083387 | 1 | ✅ | — |
| antiguamente | 573128658195 | 0 | ✅ | ANTIGUAMENTE |
| Marina Pena | 573059165436 | 0 | ✅ | — |
| karmainfersota | 573242109078 | 0 | ✅ | — |
| — | 573112724474 | 0 | ✅ | — |

### Conversaciones
- **Total:** 643 mensajes en 11 hilos
- **Tamaño:** 247 KB
- **Conversación más activa:** 573147471086 (mensajes mixtos personales/comerciales)

### Textos Predefinidos (7)
Saludos, comida, sabiduría, servicio, inspiración

### Contactos Guardados (2)
antiguamente (573128658195), Viejo (318)

---

## Seguridad y Despliegue

### Lock File (.bot.lock)
- Formato: `PID|TIMESTAMP`
- Heartbeat cada 15 segundos
- Si heartbeat > 60s → lock stale → puede ser tomado
- Si PID no existe → proceso muerto → lock liberado
- Solo 1 instancia puede correr a la vez

### Deploy Marker (.deploy.marker)
- Detecta si otra instancia se deployó después de esta
- Si se detecta → esta instancia se apaga (process.exit)
- Se borra después de conexión exitosa a WhatsApp

### Gestión de Errores
- `unhandledRejection` → log sin crash
- `uncaughtException` → log con stack trace
- `EADDRINUSE` → graceful exit (otro proceso en el puerto)
- Baileys `connection.update` maneja códigos:
  - 440: Otra instancia tomó control
  - 401/404: Sesión cerrada permanentemente
  - Otros: Reconexión con backoff exponencial (máx 10 intentos)

### Variables de Entorno
- `MISTRAL_API_KEY` — API key de Mistral AI
- `PORT` — Puerto del servidor (3000)
- `NODE_ENV` — production

---

## Problemas Conocidos y Limitaciones

### Bugs / Funciones No Implementadas

1. **`contactEnabled()` (línea 91) — definida pero nunca llamada.** El toggle de bot por contacto (`set-bot-enabled`) guarda el valor pero NO afecta el auto-reply. El bot responde a todos los contactos sin importar `botEnabled: false`.

2. **`detectUserContext()` (línea 203) — definida pero nunca llamada.** La clasificación de contexto (comercial/sabiduría/mixto/neutral) está implementada pero no se usa. La personalidad dual se maneja completamente vía el system prompt de Mistral.

3. **`operatorContexts` (línea 432) — se popula pero nunca se consume.** El evento `operator-inject-context` guarda contexto pero `getMistralReply()` nunca lo lee.

4. **No hay manejo de llamadas.** El `settings.calls` tiene mensajes configurados pero no hay código que detecte llamadas entrantes en Baileys.

5. **No hay rate limiting.** Cualquier cliente puede hacer spam de `send-message`, `send-media`, etc.

6. **`addToHistory()` usa schema diferente** a los mensajes del panel web. Los mensajes del historial AI tienen `{ role, body, ts }` mientras que los del panel tienen `{ id, type, from, number, body, timestamp }`.

### Limitaciones Técnicas

- **Hosting compartido:** Sin Chrome/Puppeteer, sin acceso root
- **Mistral tiny:** Modelo pequeño, puede dar respuestas genéricas
- **max_tokens: 300:** Limita longitud de respuestas AI
- **Timeout 25s:** Puede fallar con respuestas largas de Mistral
- **Conversaciones.json crece:** Sin límite de tamaño del archivo (solo límite de 300 mensajes por contacto)
- **Sin autenticación:** El panel web no tiene login/contraseña
- **Sin HTTPS:** Depende del proxy de Hostinger
- **Sin backups automáticos:** Los JSON se guardan en disco local

---

## Commits Recientes

| Hash | Descripción |
|------|-------------|
| `f5bc483` | fix: AI replies now appear in web chat history |
| `445b7d1` | feat: add 'Solicitar QR' button with improved disconnect flow |
| `2073811` | feat: redesign panel with glassmorphism, contact cards, QR overlay, sidebar |
| `68a8377` | feat: add file attachment, send-media, predefined texts CRUD |
| `132015b` | feat: add LID resolution system, merge duplicate contacts |
| `574630e` | feat: add operator draft refinement, call log, config panel |
| `7e34b75` | feat: initial redesign with contact cards and badges |
| `e7f0753` | feat: save contacts, fixed operator draft field name |

---

## Mejoras Posibles (Sin Dañar Nada)

### Prioridad Alta — Bugs a Corregir

1. **Conectar `contactEnabled()` al pipeline de auto-reply.** En `messages.upsert` (línea ~926), agregar verificación antes de generar respuesta AI:
   ```js
   if (!contactEnabled(number)) continue; // Saltar auto-reply si bot desactivado
   ```

2. **Implementar detección de llamadas.** Agregar evento `call` en Baileys para detectar llamadas entrantes y responder con el mensaje de `settings.calls`.

### Prioridad Media — Funcionalidad Nueva

3. **Autenticación del panel web.** Agregar login básico (usuario/contraseña) para proteger el panel.

4. **Rate limiting.** Limitar mensajes por minuto/contacto para evitar spam.

5. **Backup automático de conversations.json.** Copiar a `database/backups/` con timestamp.

6. **Consumir `operatorContexts`.** Pasar contexto del operador a `getMistralReply()` para personalizar respuestas.

7. **Límite de tamaño de conversations.json.** Implementar rotación o archivado de conversaciones antiguas.

### Prioridad Baja — Mejoras de UX

8. **Notificaciones del navegador.** Mostrar notificación cuando llegue mensaje nuevo.

9. **Búsqueda en conversaciones.** Filtro de texto dentro del chat.

10. **Exportar conversaciones.** Descargar chat como TXT/PDF.

11. **Mensajes programados.** Enviar mensajes en horarios específicos.

12. **Dashboard de métricas.** Gráficos de mensajes por día, horarios pico, etc.
