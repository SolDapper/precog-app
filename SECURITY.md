# Security Policy

## Scope

This policy covers security vulnerabilities in:

- **precog-app** - The web application (this repo)
- **precog-markets** - The JavaScript SDK ([npm](https://www.npmjs.com/package/precog-markets) / [GitHub](https://github.com/SolDapper/precog-markets))
- **precog** - The Solana program ([GitHub](https://github.com/honeygrahams2/precog))

## Reporting a Vulnerability

If you discover a security vulnerability in any Precog Markets component, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, report via DM on X (Twitter): [@SolDapper](https://x.com/SolDapper)

Please include:

- A description of the vulnerability
- Steps to reproduce the issue
- The potential impact
- Any suggested fixes (if applicable)

## Response

We aim to acknowledge reports within 48 hours and provide an initial assessment within 7 days.

## What Qualifies

- Smart contract vulnerabilities (fund theft, unauthorized access, state corruption)
- Transaction manipulation or replay attacks
- PDA derivation flaws allowing unauthorized claims
- Token account exploits
- Frontend vulnerabilities enabling wallet draining or phishing
- Dependency vulnerabilities with a practical exploit path

## What Does Not Qualify

- Theoretical attacks without a practical exploit
- Denial-of-service against RPC endpoints (not in our control)
- Social engineering attacks
- Issues in third-party wallets or RPC providers
- Cosmetic UI bugs

## Architecture Considerations

Precog Markets has no backend server, database, or API. The app is a static frontend that interacts directly with the Solana blockchain through user-connected wallets. All funds are held by the on-chain program in PDA-controlled vaults, not by any off-chain service.

Key security boundaries:

- **On-chain program** - Controls all fund movement, market lifecycle, and access control
- **Client app** - Constructs and submits transactions; never has custody of funds
- **SDK** - Builds instructions and deserializes accounts; stateless
- **Wallet** - User controls signing; the app never accesses private keys

## Supported Versions

Security fixes are applied to the latest release only. We do not backport fixes to older versions.
