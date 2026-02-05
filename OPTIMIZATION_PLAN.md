# Plan Exhaustivo de Optimización - Mention App

## Resumen Ejecutivo

Este plan aborda mejoras en rendimiento, eficiencia y limpieza de código para el monorepo de Mention (frontend Expo/React Native + backend Express/MongoDB). Se organiza en 6 fases priorizadas por impacto y riesgo.

---

## Fase 1: Correcciones Críticas de Rendimiento (Backend)

### 1.1 Eliminar problemas N+1 en consultas a base de datos

**Problema**: En `feed.controller.ts:170-196`, el reemplazo de menciones ejecuta llamadas individuales a `oxyClient.getUserById()` dentro de un bucle `for`. Con 50 menciones por página, esto genera 50 llamadas secuenciales a la API.

**Archivos afectados**:
- `packages/backend/src/controllers/feed.controller.ts` (líneas 170-196)
- `packages/backend/src/controllers/posts.controller.ts` (líneas 1473, 1528, 1665, 1688)
- `packages/backend/src/routes/notifications.ts` (líneas 125, 324, 391)
- `packages/backend/src/services/PostHydrationService.ts` (líneas 117-150)

**Solución**:
- Recopilar todos los IDs de usuario únicos antes del bucle
- Hacer una sola llamada batch `oxyClient.getUsersByIds(uniqueIds)`
- Crear un Map de resultados para lookup O(1)
- Aplicar el mismo patrón en `PostHydrationService.buildViewerContext()`

```typescript
// ANTES (N+1)
for (const userId of mentions) {
  const userData = await oxyClient.getUserById(userId);
}

// DESPUÉS (batch)
const uniqueUserIds = [...new Set(mentions)];
const usersMap = await oxyClient.getUsersByIds(uniqueUserIds);
for (const userId of mentions) {
  const userData = usersMap.get(userId);
}
```

### 1.2 Optimizar populate() en Mongoose

**Problema**: Múltiples consultas usan `.populate('userID')` sin selección de campos y sin `.lean()`, retornando documentos Mongoose completos cuando solo se necesitan datos de lectura.

**Archivos afectados**:
- `packages/backend/src/controllers/posts.controller.ts` (líneas 1473, 1528, 1665, 1688)
- `packages/backend/src/routes/notifications.ts` (línea 125)

**Solución**:
- Agregar `.lean()` a todas las consultas de solo lectura
- Usar selección de campos en populate: `.populate('userID', 'username avatar displayName')`
- Considerar denormalización para datos accedidos frecuentemente (username, avatar)

### 1.3 Eliminar broadcast storms en WebSockets

**Problema**: En `server.ts:1564-1569`, eventos como `post:liked` se emiten a TODOS los clientes conectados con `io.emit()`. Con 100k usuarios conectados, cada "like" genera 100k mensajes.

**Archivos afectados**:
- `packages/backend/server.ts` (líneas 1564-1569)

**Solución**:
- Usar rooms de Socket.IO en vez de broadcast global
- Cada usuario se une al room de sus posts y de los posts que está viendo
- Solo emitir a rooms relevantes: `io.to(postRoom).emit('post:liked', data)`
- Agregar rate limiting en eventos de socket (actualmente inexistente)

```typescript
// ANTES
io.emit('post:liked', { postId, userId });

// DESPUÉS
io.to(`post:${postId}`).emit('post:liked', { postId, userId });
io.to(`user:${post.authorId}:notifications`).emit('notification', data);
```

---

## Fase 2: Mejoras de Caché y Datos (Backend)

### 2.1 Implementar caché de consultas para Posts y Usuarios

**Problema**: Cada request al feed consulta la base de datos directamente. No hay caché de resultados de queries frecuentes (perfiles de usuario, posts populares).

**Archivos afectados**:
- `packages/backend/src/services/FeedCacheService.ts`
- `packages/backend/src/controllers/feed.controller.ts`
- `packages/backend/src/services/PostHydrationService.ts`

**Solución**:
- Implementar caché Redis para perfiles de usuario (TTL: 5 min)
- Cache de posts populares y trending (TTL: 2 min)
- Cache de relaciones de follow (TTL: 10 min)
- Cache de datos de polls y artículos (TTL: 5 min)
- Invalidación inteligente vía pub/sub cuando se actualizan datos

```typescript
// Nuevo servicio: QueryCacheService
class QueryCacheService {
  private readonly USER_TTL = 300;      // 5 min
  private readonly POST_TTL = 120;       // 2 min
  private readonly FOLLOW_TTL = 600;     // 10 min

  async getUser(id: string): Promise<User> {
    return this.getOrSet(`user:${id}`, () => oxyClient.getUserById(id), this.USER_TTL);
  }

  async getUsersBatch(ids: string[]): Promise<Map<string, User>> {
    // Check cache first, fetch missing, cache results
  }
}
```

### 2.2 Optimizar la hidratación de posts

**Problema**: `postHydrationService.hydratePosts()` hace 3-4 llamadas separadas (posts + usuarios + polls + link metadata) por cada página de feed. Esto incluye metadata completa aunque no siempre se necesita.

**Archivos afectados**:
- `packages/backend/src/services/PostHydrationService.ts`
- `packages/backend/src/controllers/feed.controller.ts` (líneas 206-239)

**Solución**:
- Implementar hidratación parcial: solo hidratar lo visible en la primera carga
- Lazy-load metadata de links, polls y artículos bajo demanda
- Crear un endpoint `/posts/:id/metadata` para carga bajo demanda
- Pre-computar y cachear datos de hidratación para posts populares

### 2.3 Reducir procesamiento de menciones post-hidratación

**Problema**: `replaceMentionPlaceholders()` se ejecuta después de la hidratación, requiriendo lookups adicionales de usuarios. Este procesamiento debería hacerse una vez y cachearse.

**Archivos afectados**:
- `packages/backend/src/controllers/feed.controller.ts` (líneas 170-196)

**Solución**:
- Pre-procesar menciones al crear/editar un post (write-time processing)
- Almacenar el texto renderizado en un campo `renderedContent` del post
- Invalidar `renderedContent` solo cuando un usuario cambia de nombre
- Eliminar procesamiento en tiempo de lectura

---

## Fase 3: Correcciones Críticas de Frontend

### 3.1 Corregir hook useDeepCompare

**Problema**: En `useDeepCompare.ts:8-19`, `deepEqual` se llama durante el render, violando las reglas de React. Esto causa closures obsoletos y posibles memory leaks.

**Archivo afectado**:
- `packages/frontend/hooks/useDeepCompare.ts` (líneas 8-19)

**Solución**:
```typescript
// ANTES (viola reglas de React)
export function useDeepCompareEffect(callback, dependencies) {
  const currentDependenciesRef = useRef(undefined);
  // deepEqual durante render - MAL
  if (!currentDependenciesRef.current || !deepEqual(currentDependenciesRef.current, dependencies)) {
    currentDependenciesRef.current = dependencies;
  }
  useEffect(callback, currentDependenciesRef.current);
}

// DESPUÉS (correcto)
export function useDeepCompareEffect(callback, dependencies) {
  const ref = useRef(0);
  const prevDeps = useRef(dependencies);

  if (!deepEqual(prevDeps.current, dependencies)) {
    ref.current += 1;
    prevDeps.current = dependencies;
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(callback, [ref.current]);
}
```

### 3.2 Corregir condición de carrera en usePostLike

**Problema**: En `usePostLike.ts:21-23`, se usa `setTimeout(300ms)` para prevenir doble-click, pero esto permite duplicados si el usuario clickea durante el timeout.

**Archivo afectado**:
- `packages/frontend/hooks/usePostLike.ts` (líneas 21-23)

**Solución**:
- Usar un AbortController o un flag booleano que se resetea después de la respuesta del servidor
- Eliminar el setTimeout y usar un mutex basado en promesas

```typescript
// ANTES
finally {
  setTimeout(() => { actionRef.current = null; }, 300);
}

// DESPUÉS
const pendingRef = useRef(false);
const toggleLike = useCallback(async () => {
  if (pendingRef.current) return;
  pendingRef.current = true;
  try {
    // optimistic update + API call
  } finally {
    pendingRef.current = false;
  }
}, [...]);
```

### 3.3 Mejorar memoización de PostItem

**Problema**: `PostItem.tsx:529` usa `React.memo()` sin función de comparación personalizada, causando re-renders innecesarios cuando el padre se re-renderiza con los mismos datos.

**Archivo afectado**:
- `packages/frontend/components/Feed/PostItem.tsx` (línea 529)

**Solución**:
```typescript
// ANTES
export default React.memo(PostItem);

// DESPUÉS
export default React.memo(PostItem, (prevProps, nextProps) => {
  return (
    prevProps.post._id === nextProps.post._id &&
    prevProps.post.stats?.likes === nextProps.post.stats?.likes &&
    prevProps.post.stats?.reposts === nextProps.post.stats?.reposts &&
    prevProps.post.stats?.replies === nextProps.post.stats?.replies &&
    prevProps.post.updatedAt === nextProps.post.updatedAt &&
    prevProps.isLiked === nextProps.isLiked &&
    prevProps.isReposted === nextProps.isReposted &&
    prevProps.isBookmarked === nextProps.isBookmarked
  );
});
```

### 3.4 Reducir re-renders en LazyImage

**Problema**: En `LazyImage/index.tsx:76-79`, hay 4 llamadas separadas a `useState` que pueden disparar actualizaciones en cascada.

**Archivo afectado**:
- `packages/frontend/components/ui/LazyImage/index.tsx` (líneas 76-79)

**Solución**:
- Combinar estados relacionados en un solo `useReducer`
- Usar `unstable_batchedUpdates` o React 18+ automatic batching

```typescript
// ANTES
const [isVisible, setIsVisible] = useState(false);
const [isLoaded, setIsLoaded] = useState(false);
const [shouldLoadHighRes, setShouldLoadHighRes] = useState(false);
const [hasError, setHasError] = useState(false);

// DESPUÉS
type ImageState = {
  isVisible: boolean;
  isLoaded: boolean;
  shouldLoadHighRes: boolean;
  hasError: boolean;
};

const [state, dispatch] = useReducer(imageReducer, initialState);
```

---

## Fase 4: Limpieza y Arquitectura de Código (Backend)

### 4.1 Consolidar query builders duplicados

**Problema**: Existen 3 implementaciones separadas de construcción de queries de feed: `buildFeedQuery()` en el controlador, `FeedQueryBuilder.buildQuery()` como servicio, y construcción inline en endpoints individuales.

**Archivos afectados**:
- `packages/backend/src/controllers/feed.controller.ts` (línea 250)
- `packages/backend/src/utils/feedQueryBuilder.ts`
- Múltiples endpoints de feed

**Solución**:
- Consolidar todo en `FeedQueryBuilder`
- Eliminar `buildFeedQuery()` del controlador
- Usar el builder como único punto de entrada para queries de feed
- Documentar los métodos del builder

### 4.2 Extraer lógica de privacidad duplicada

**Problema**: La lógica de filtrado por privacidad está duplicada en `feed.controller.ts:80-164` y en `PostHydrationService.ts:9-40`.

**Archivos afectados**:
- `packages/backend/src/controllers/feed.controller.ts` (líneas 80-164)
- `packages/backend/src/services/PostHydrationService.ts` (líneas 9-40)

**Solución**:
- Crear `PrivacyService` centralizado
- Mover toda la lógica de filtrado de privacidad ahí
- Usar el servicio desde controladores y otros servicios

### 4.3 Estandarizar formato de respuesta de API

**Problema**: Respuestas inconsistentes - algunos endpoints usan `{ error: '', message: '' }` y otros `{ success: false, error: '' }`.

**Solución**:
- Crear un response wrapper estándar:
```typescript
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
  pagination?: { nextCursor?: string; hasMore: boolean };
}

// Helper
function sendSuccess<T>(res: Response, data: T, status = 200) {
  res.status(status).json({ success: true, data });
}

function sendError(res: Response, code: string, message: string, status = 500) {
  res.status(status).json({ success: false, error: { code, message } });
}
```

### 4.4 Dividir PostHydrationService

**Problema**: `PostHydrationService` es un "god service" que maneja hidratación de usuarios, polls, links, privacidad y contexto de viewer.

**Archivo afectado**:
- `packages/backend/src/services/PostHydrationService.ts`

**Solución**:
- Dividir en servicios más pequeños:
  - `UserHydrationService`: lookup y cache de datos de usuario
  - `PollHydrationService`: datos de polls
  - `LinkMetadataService`: metadata de links
  - `ViewerContextService`: contexto del viewer (blocked, restricted, etc.)
- `PostHydrationService` orquesta los sub-servicios

### 4.5 Extraer utilidades compartidas de regex

**Problema**: El regex `/#([A-Za-z0-9_]+)/g` para extracción de hashtags/menciones aparece duplicado en `feed.controller.ts:1348` y `posts.controller.ts:306`.

**Archivos afectados**:
- `packages/backend/src/controllers/feed.controller.ts` (línea 1348)
- `packages/backend/src/controllers/posts.controller.ts` (línea 306)

**Solución**:
- Crear módulo `packages/backend/src/utils/textProcessing.ts`
- Exportar funciones: `extractHashtags()`, `extractMentions()`, `replaceMentions()`

### 4.6 Agregar validación de input con middleware

**Problema**: No hay validación de runtime para request bodies. Se confía en tipos TypeScript que no validan en runtime.

**Solución**:
- Usar Zod (ya es dependencia del frontend) para validación de schemas
- Crear middleware de validación:
```typescript
// middleware/validate.ts
import { z } from 'zod';

const createPostSchema = z.object({
  content: z.string().min(1).max(5000),
  attachments: z.array(z.string().url()).max(4).optional(),
  pollOptions: z.array(z.string()).min(2).max(4).optional(),
});

function validate(schema: z.ZodSchema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return sendError(res, 'VALIDATION_ERROR', result.error.message, 400);
    }
    req.validatedBody = result.data;
    next();
  };
}
```

### 4.7 Centralizar configuración y constantes

**Problema**: Constantes hardcoded dispersas por todo el código (timeouts de socket, TTLs de cache, límites de rate limiting).

**Solución**:
- Crear `packages/backend/src/config/index.ts`:
```typescript
export const config = {
  cache: {
    userTTL: parseInt(process.env.CACHE_USER_TTL || '300'),
    postTTL: parseInt(process.env.CACHE_POST_TTL || '120'),
    feedTTL: parseInt(process.env.CACHE_FEED_TTL || '900'),
  },
  rateLimit: {
    authenticated: { max: 1000, windowMs: 900000 },
    unauthenticated: { max: 100, windowMs: 900000 },
  },
  socket: {
    pingTimeout: 30000,
    pingInterval: 25000,
  },
  db: {
    socketTimeoutMS: 45000,
    serverSelectionTimeoutMS: 20000,
  },
} as const;
```

- Validar variables de entorno al inicio con Zod:
```typescript
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  NODE_ENV: z.enum(['development', 'production', 'staging']),
});

envSchema.parse(process.env); // Falla al inicio si falta algo
```

---

## Fase 5: Limpieza y Arquitectura de Código (Frontend)

### 5.1 Descomponer componentes grandes

**Problema**: Varios componentes superan las 400 líneas, haciéndolos difíciles de mantener y testear.

**Componentes a dividir**:

| Componente | Líneas | Acción |
|------------|--------|--------|
| `ZoomableAvatar.tsx` | 547 | Extraer gesture handlers y animation logic |
| `PostItem.tsx` | 530 | Extraer PostActions, PostHeader, PostContent |
| `ProfileScreen.tsx` | 468 | Extraer ProfileHeader, ProfileStats, ProfileTabs |
| `NotificationItem.tsx` | 468 | Extraer por tipo de notificación |
| `PostAttachmentsRow.tsx` | 436 | Extraer ImageGrid, VideoAttachment, LinkPreview |

**Patrón de descomposición**:
```
PostItem/
├── index.tsx          (orquestador, ~100 líneas)
├── PostHeader.tsx     (avatar, nombre, timestamp)
├── PostContent.tsx    (texto, menciones, hashtags)
├── PostActions.tsx    (like, repost, reply, bookmark)
├── PostMedia.tsx      (imágenes, videos)
└── types.ts           (tipos compartidos del post)
```

### 5.2 Crear módulo de constantes de timing

**Problema**: Valores de timeout hardcodeados dispersos por la app: SearchBar (300ms), MentionPicker (300ms), LazyImage (50/100/300ms), usePostLike (300ms).

**Archivos afectados**:
- `packages/frontend/components/SearchBar.tsx`
- `packages/frontend/components/MentionPicker.tsx`
- `packages/frontend/components/ui/LazyImage/index.tsx`
- `packages/frontend/hooks/usePostLike.ts`

**Solución**:
```typescript
// constants/timing.ts
export const TIMING = {
  DEBOUNCE_SEARCH: 300,
  DEBOUNCE_MENTION: 300,
  IMAGE_LOW_RES_DISPLAY: 300,
  IMAGE_INTERSECTION_THRESHOLD: 200,
  ANIMATION_FADE_IN: 100,
  ACTION_COOLDOWN: 300,
} as const;
```

### 5.3 Eliminar wrapper innecesario useOptimizedQuery

**Problema**: `useOptimizedQuery` envuelve React Query sin añadir funcionalidad significativa.

**Archivo afectado**:
- `packages/frontend/hooks/useOptimizedQuery.ts`

**Solución**:
- Evaluar si el wrapper añade valor real
- Si no, eliminarlo y usar React Query directamente
- Si sí, documentar claramente qué optimización añade

### 5.4 Mejorar estabilidad de claves de caché en feedService

**Problema**: En `feedService.ts:86`, `JSON.stringify(filters)` genera muchas entradas de caché para objetos de filtro ligeramente diferentes (diferente orden de keys, undefined vs ausente).

**Archivo afectado**:
- `packages/frontend/services/feedService.ts` (línea 86)

**Solución**:
```typescript
// ANTES
const cacheKey = JSON.stringify(filters);

// DESPUÉS
function stableCacheKey(filters: FeedFilters): string {
  const normalized = {
    type: filters.type || 'default',
    userId: filters.userId || '',
    cursor: filters.cursor || '',
    limit: filters.limit || 20,
  };
  return `${normalized.type}:${normalized.userId}:${normalized.cursor}:${normalized.limit}`;
}
```

### 5.5 Agregar Error Boundaries

**Problema**: Falta de error boundaries en componentes que renderizan contenido dinámico. Si un post malformado causa un error, toda la pantalla crashea.

**Archivos afectados**:
- `packages/frontend/components/Post/PostAttachmentsRow.tsx`
- `packages/frontend/components/Feed/Feed.tsx`
- `packages/frontend/components/Feed/PostItem.tsx`

**Solución**:
```typescript
// components/ErrorBoundary.tsx
class PostErrorBoundary extends React.Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return <PostErrorFallback onRetry={() => this.setState({ hasError: false })} />;
    }
    return this.props.children;
  }
}

// Uso en Feed
<PostErrorBoundary key={post._id}>
  <PostItem post={post} />
</PostErrorBoundary>
```

### 5.6 Reducir dependency array de fetchInitial en Feed.tsx

**Problema**: En `Feed.tsx:246-258`, `fetchInitial` tiene 13 dependencias, causando recreación frecuente del callback.

**Archivo afectado**:
- `packages/frontend/components/Feed/Feed.tsx` (líneas 246-258)

**Solución**:
- Agrupar dependencias estables en un ref
- Usar un custom hook `useFeedActions` que encapsule la lógica de fetch
- Reducir el número de callbacks pasados como dependencias

```typescript
// ANTES: 13 dependencias
const fetchInitial = useCallback(async () => { ... }, [
  type, userId, showOnlySaved, useScoped, isAuthenticated,
  currentUserId, filters, fetchFeed, fetchUserFeed,
  refreshFeed, clearError,
]);

// DESPUÉS: hook dedicado
const { fetchInitial, refresh } = useFeedActions({
  type, userId, showOnlySaved, useScoped, filters,
});
```

---

## Fase 6: Seguridad y Robustez

### 6.1 Validar autenticación en WebSockets

**Problema**: En `server.ts:257-274`, la autenticación de socket acepta `userId` del handshake del cliente sin verificación de token JWT.

**Archivo afectado**:
- `packages/backend/server.ts` (líneas 257-274)

**Solución**:
```typescript
// ANTES (inseguro)
const userId = auth?.userId || auth?.id || auth?.user?.id;
if (userId && typeof userId === "string") {
  socket.user = { id: userId };
}

// DESPUÉS (con verificación JWT)
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = { id: decoded.userId };
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});
```

### 6.2 Corregir CORS permisivo

**Problema**: En `server.ts:117`, CORS permite `*` como fallback cuando `FRONTEND_URL` no está definido.

**Solución**:
- Nunca permitir `*` en producción
- Validar que `FRONTEND_URL` existe al inicio
- Usar whitelist de dominios permitidos

### 6.3 Agregar rate limiting a eventos de Socket

**Problema**: Los clientes pueden emitir eventos de socket ilimitados sin throttling.

**Solución**:
```typescript
// Middleware de rate limiting para Socket.IO
const socketRateLimiter = new Map<string, number[]>();

function rateLimitSocket(socket, eventName, maxPerMinute = 60) {
  const key = `${socket.user.id}:${eventName}`;
  const now = Date.now();
  const timestamps = socketRateLimiter.get(key) || [];
  const recent = timestamps.filter(t => now - t < 60000);

  if (recent.length >= maxPerMinute) {
    socket.emit('error', { message: 'Rate limit exceeded' });
    return false;
  }

  recent.push(now);
  socketRateLimiter.set(key, recent);
  return true;
}
```

### 6.4 Proteger contra memory leaks en onlineUsers

**Problema**: En `server.ts:427-436`, el Map `onlineUsers` puede crecer indefinidamente si eventos de disconnect fallan.

**Solución**:
- Agregar cleanup periódico (cada 5 minutos)
- Usar Redis para tracking de presencia en vez de Map en memoria
- Implementar heartbeat timeout

---

## Fase 7: Testing y Observabilidad

### 7.1 Implementar tests en backend

**Problema**: El backend no tiene tests automatizados (solo placeholder "Error: no test specified").

**Solución**:
- Configurar Jest con ts-jest para el backend
- Tests unitarios prioritarios:
  - `FeedQueryBuilder` - lógica de queries
  - `FeedRankingService` - algoritmo de ranking
  - `PostHydrationService` - hidratación de posts
  - Middleware de rate limiting
  - Validación de schemas
- Tests de integración:
  - Flujo completo de creación de post
  - Flujo de feed con caché
  - Autenticación y autorización

### 7.2 Mejorar tests de frontend

**Solución**:
- Tests unitarios para hooks críticos:
  - `useDeepCompare` (después de la corrección)
  - `usePostLike`
  - `useFeedState`
- Tests de componentes:
  - `PostItem` con diferentes tipos de posts
  - `Feed` con estados de carga, error, vacío
  - `LazyImage` con diferentes estados

### 7.3 Agregar métricas de rendimiento

**Solución**:
- Instrumentar tiempos de respuesta de API
- Medir hit rate de caché (L1 y L2)
- Tracking de latencia de WebSocket
- Métricas de rendering en frontend (FPS, TTI)

---

## Resumen de Impacto Esperado

| Fase | Categoría | Impacto en Rendimiento | Impacto en Mantenibilidad |
|------|-----------|----------------------|--------------------------|
| 1 | N+1 queries + broadcasts | **ALTO** - Reduce latencia de feed 50-70% | Medio |
| 2 | Caché y datos | **ALTO** - Reduce carga de DB 60-80% | Medio |
| 3 | Correcciones frontend | **MEDIO** - Elimina re-renders y bugs | Alto |
| 4 | Arquitectura backend | Bajo | **ALTO** - Código más mantenible |
| 5 | Arquitectura frontend | Bajo-Medio | **ALTO** - Componentes más testables |
| 6 | Seguridad | N/A (seguridad) | Medio |
| 7 | Testing | N/A (calidad) | **ALTO** - Previene regresiones |

---

## Orden de Ejecución Recomendado

```
Semana 1-2: Fase 1 (N+1, populate, broadcasts) ← Mayor impacto inmediato
Semana 2-3: Fase 3 (useDeepCompare, usePostLike, PostItem memo)
Semana 3-4: Fase 2 (Caché de queries, hidratación parcial)
Semana 4-5: Fase 6 (Seguridad de sockets, CORS, rate limiting)
Semana 5-7: Fase 4 (Refactor backend: servicios, validación, config)
Semana 7-9: Fase 5 (Refactor frontend: componentes, error boundaries)
Semana 9-10: Fase 7 (Tests y observabilidad)
```

Cada fase es independiente y puede ejecutarse sin bloquear las demás, pero el orden prioriza las mejoras con mayor impacto en rendimiento y estabilidad.
