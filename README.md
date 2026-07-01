# Precog Markets

A trustless, non-custodial prediction market app built on Solana. Anyone can create pari-mutuel markets, share them, and earn maker fees - all 100% on-chain with zero backend infrastructure.

**Live:** [precogmarket.com](https://www.precogmarket.com)

## Architecture

Precog Markets is a single-page application that interacts directly with the Solana blockchain. There is no backend server, no database, and no API layer. The app reads market data from on-chain program accounts via RPC and submits transactions through the user's connected wallet.

```
Browser App (this repo)
    |
    +--> precog-markets SDK (npm)
    |        |
    |        +--> Solana Program (on-chain)
    |
    +--> Solana RPC (Helius, Triton, etc.)
    +--> Jupiter Price API (USD values)
    +--> SNS (Solana Name Service for .sol names)
```

**App** - Parcel-bundled vanilla JS SPA with no framework dependencies. Source lives in `src/`.

**SDK** - The [precog-markets](https://www.npmjs.com/package/precog-markets) npm package handles instruction building, account deserialization, PDA derivation, compute estimation, and priority fees. RPC-agnostic - works with any Solana RPC provider.

**Program** - The Solana program source is available at [github.com/honeygrahams2/precog](https://github.com/honeygrahams2/precog). Deploy your own instance to run a fully independent protocol.

## Prerequisites

- Node.js 18+ (LTS recommended)
- npm 9+
- A Solana RPC endpoint (mainnet or devnet)
- A Solana wallet (Phantom, Solflare, Backpack, etc.)

## Setup

Clone the repo and install dependencies:

```bash
git clone https://github.com/SolDapper/precog-app.git
cd precog-app
npm install
```

Create a `.env` file from the template:

```bash
cp env.txt .env
```

Edit `.env` with your configuration (see Environment Variables below).

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PROGRAM_ID` | Yes | - | Solana program address for the deployed Precog Markets protocol |
| `RPC_URL` | Yes | - | Solana RPC endpoint (e.g. `https://mainnet.helius-rpc.com?api-key=YOUR_KEY`) |
| `WSS_URL` | No | - | WebSocket RPC endpoint (e.g. `wss://mainnet.helius-rpc.com?api-key=YOUR_KEY`) |
| `TOLERANCE` | No | `1.1` | Compute unit estimation multiplier. Higher values add more headroom (e.g. `1.3` = 30% buffer) |
| `PRIORITY` | No | `Medium` | Priority fee level: `Min`, `Low`, `Medium`, `High`, or `VeryHigh` |
| `JUP_API_KEY` | No | - | Jupiter Price API key for USD values. Get a free key at [portal.jup.ag](https://portal.jup.ag) |
| `STREET_BET_SECONDS` | No | `1800` | Maximum runtime (seconds) for a market to be tagged as a "Street Bet" |
| `TOKEN_GATE` | No | - | Comma-separated token mint addresses. When set, wallets must hold >0 of any listed token to create markets or place positions |
| `TG_TOKEN` | No | - | Telegram bot token (for the optional notification bot) |
| `TG_GROUPS` | No | - | Comma-separated Telegram group IDs for notifications |

## Running Locally

Start the Parcel dev server:

```bash
npm start
```

This launches at `http://localhost:1234` with hot module replacement.

## Building for Production

```bash
npm run build
```

Parcel outputs optimized, minified bundles to the `dist/` directory. Static assets from `.well-known/` are copied automatically.

## Deploying

### Heroku

The project includes a `Procfile` for Heroku deployment. Push to Heroku and set your environment variables:

```bash
heroku config:set PROGRAM_ID=your_program_id
heroku config:set RPC_URL=your_rpc_url
heroku config:set JUP_API_KEY=your_jup_key
git push heroku main
```

### Custom Hosting

After `npm run build`, deploy the contents of `dist/` to any static hosting provider (Netlify, Vercel, Cloudflare Pages, S3, etc.). Environment variables are baked in at build time via Parcel's `process.env` replacement, so set them before building.

## Project Structure

```
precog-app/
  .well-known/          Static assets (logo, icons, promo images)
  scripts/              Utility scripts (Telegram bot)
  src/
    css/
      app.css           All styles (mobile-first, dark theme, blue accent)
    js/
      app.js            Main application logic, views, filters, transactions
      config.js         Environment variable exports
      gate.js           Token gate check (wallet must hold required token)
      makers.js         Saved market makers (localStorage)
      sdk.js            Bridge to precog-markets SDK
      sns.js            Solana Name Service resolution
      ui.js             DOM rendering (market cards, detail page, position cards)
      wallet.js         Wallet adapter (Wallet Standard, mobile deep links)
      watchlist.js       Watchlist categories (localStorage)
    index.html          Single page app shell
  env.txt               Environment variable template
  package.json
  Procfile              Heroku process definition
  service-worker.js     PWA service worker
```

## Configuration

### Deploying Your Own Protocol

To run a fully independent prediction market:

1. Deploy the [Solana program](https://github.com/honeygrahams2/precog) to your desired cluster
2. Initialize the protocol by connecting as the admin wallet on the Admin page
3. Set the `PROGRAM_ID` in your `.env` to your deployed program address
4. Update hardcoded domain references (see below)
5. Build and deploy the app

All markets, positions, fees, and payouts are scoped to your program instance. Multiple independent protocols can coexist on the same Solana cluster.

### Domain and Branding

The following files contain hardcoded domain and branding references that you should update when deploying your own instance:

- **`src/index.html`** - Open Graph and Twitter meta tags (`og:url`, `og:image`, `twitter:image`), footer link, social links in the WUT page, and the page `<title>`
- **`src/js/config.js`** - The `APP_IDENTITY` object (`name`, `uri`, `icon`) used by the Solana Mobile Wallet Adapter (MWA) to identify your app during wallet connections on mobile. Update all three fields to match your deployment
- **`src/js/app.js`** - Share text that includes the app name

Search for `precogmarket.com` across the source to find all references.

### RPC Providers

The app and SDK are RPC-agnostic. Tested with:

- **Helius** - `https://mainnet.helius-rpc.com?api-key=KEY`
- **Triton** - `https://your-endpoint.triton.one`
- **QuickNode** - `https://your-endpoint.quiknode.pro`

Priority fee estimation uses the standard Solana RPC method `getRecentPrioritizationFees`, which works with all providers. For provider-specific estimation, the SDK accepts a custom `feeEstimator` function.

### Token Gate

Set `TOKEN_GATE` to a comma-separated list of token mint addresses to restrict market creation and position placement to wallets holding at least one of those tokens. Browsing, viewing, and claiming are always open.

```
TOKEN_GATE=MintAddress1,MintAddress2
```

### Market Denominations

Markets support three denomination types:

- **Native SOL** - Standard SOL transfers
- **SPL Token** - Any SPL Token mint
- **Token-2022** - Token-2022 mints including those with transfer fee extensions

## SDK

The [precog-markets](https://www.npmjs.com/package/precog-markets) SDK provides:

- Instruction builders for all program operations
- Account deserialization (markets, positions, protocol config)
- PDA derivation helpers
- Compute unit estimation via simulation
- RPC-agnostic priority fee estimation
- Smart transaction sending with retry logic

Install it for custom integrations:

```bash
npm install precog-markets
```

```javascript
import { PrecogMarketsClient } from 'precog-markets';
import { Connection } from '@solana/web3.js';

const connection = new Connection('https://your-rpc-endpoint');
const client = new PrecogMarketsClient(connection, {
  programId: yourProgramId,
  priorityLevel: 'Medium',
});
```

See the [SDK README](https://github.com/SolDapper/precog-markets) for full documentation.

## Links

- **App:** [precogmarket.com](https://www.precogmarket.com)
- **App Source:** [github.com/SolDapper/precog-app](https://github.com/SolDapper/precog-app)
- **SDK (npm):** [npmjs.com/package/precog-markets](https://www.npmjs.com/package/precog-markets)
- **SDK Source:** [github.com/SolDapper/precog-markets](https://github.com/SolDapper/precog-markets)
- **Program Source:** [github.com/honeygrahams2/precog](https://github.com/honeygrahams2/precog)
- **Follow:** [@SolDapper](https://x.com/SolDapper)

## License

MIT - see [LICENSE](LICENSE)
