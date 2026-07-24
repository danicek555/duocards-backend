# Cloud Run vs. lokální backend

Tento dokument popisuje, kudy teče provoz aplikací DuoCards podle toho, zda je
zapnutý nasazený backend na Google Cloud Run.

## Model

- **Cloud Run zapnutý → provoz jde přes tento nasazený backend (repo `duocards-backend`).**
  Nasazená služba je sestavená z tohoto repozitáře. Proto musí být repo
  **synchronizované** s produkční funkcionalitou — když je Cloud Run zapnutý,
  obsluhuje reálné klienty a musí umět vše, co klienti volají.
- **Cloud Run vypnutý → provoz jde přes lokální backend.**
  Klient se přepne na lokálně běžící backend (stejný kód z tohoto repa spuštěný
  přes `npm run dev`, typicky na `http://localhost:4000`, resp. na LAN adrese pro
  fyzické zařízení).

Protože nasazený i lokální backend běží ze stejného zdroje (tohoto repa) a míří
na stejnou PostgreSQL databázi, je přepnutí bezešvé — liší se pouze origin, na
který klient posílá požadavky.

## Chování klientů

### Webová aplikace (`app.duocards.xyz`)

Přepnutí je **automatické**. Klient `apiFetch` (`src/lib/apiUrl.ts`) volá sdílený
backend přes proxy `/shared-api` (→ Cloud Run) a při síťové chybě, odpovědi
5xx nebo otevřeném circuit-breakeru přepadává na interní Next.js `/api` routes.
Před zápisy kontroluje `/shared-health`. Když je Cloud Run vypnutý, provoz proto
sám spadne na lokální/interní vrstvu bez zásahu uživatele.

### Nativní iOS aplikace

Přepnutí je **řízené uživatelem** s indikací stavu:

1. Při startu aplikace proběhne health-check na `/health` nastaveného backendu
   (`AppSession.startup()` → `DuoCardsAPI.checkHealth()`).
2. Pokud backend **odpovídá**, aplikace pokračuje normálně (obnoví přihlášení).
3. Pokud backend **neodpovídá** (Cloud Run vypnutý), zobrazí se banner
   „Backend (Cloud Run) je nedostupný“ s možností *Zkusit znovu* a *Nastavit
   server*.
4. V *Nastavení serveru* (ikona ozubeného kola) může uživatel zadat adresu
   **vlastního (lokálního) backendu**, například `http://192.168.1.20:4000`.
   Klient si sám doplní cestu `/api/v1`. Uložená adresa přepíše výchozí Cloud Run
   origin; volbou *Použít výchozí Cloud Run* se aplikace vrátí zpět.

Na fyzickém iPhonu je nutné použít LAN adresu Macu, nikoli `localhost`
(ten na zařízení odkazuje na samotný telefon). Obě zařízení musí být na stejné
Wi-Fi.

## Požadavek na synchronizaci repa

Protože při zapnutém Cloud Run obsluhuje veškerý sdílený provoz právě tento
repozitář, musí zrcadlit produkční backend (`duocards-app/backend`). Aktuálně
sdílené jsou zejména:

- Prisma schema a migrace (byte-identické, aby seděly checksumy `_prisma_migrations`).
- Endpointy live-game v2 (`/api/v1/live/sessions/...`).
- Welcome bonus při registraci (100 mincí, `CoinTransaction` typu `WELCOME_BONUS`).

Při jakékoli změně chování sdílených endpointů v `duocards-app/backend` je nutné
tuto změnu přenést i sem, jinak se zapnutím Cloud Run klienti dostanou na starší
funkcionalitu.
