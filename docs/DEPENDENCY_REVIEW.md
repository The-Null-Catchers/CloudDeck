# Dependency and licensing review

November 27, 2026. Run `npm ci` with Node 22/npm 11.9.0, then `npm audit --json` and `npm ls next nodemailer postcss`. An audit clean result covers the registry's known npm advisories at that time, not all security risks or Go/Flutter dependencies.

Next.js 15.5.29 addresses the advisories listed in its [official security release](https://github.com/vercel/next.js/releases/tag/v15.5.29). Nodemailer 10.6.1 replaces 7.0.13 after reviewing its [upstream changelog](https://github.com/nodemailer/nodemailer/blob/v10.6.1/CHANGELOG.md); CloudDeck uses the existing createTransport/sendMail API with fixed message fields. A disposable SMTP integration test exercises verification, workspace invitations and operational notifications without external mail. Node 22 meets its runtime requirement. The root PostCSS override must resolve to 8.5.28 even on a fresh install; inspect the lockfile rather than trusting an incremental install audit.

The npm lockfile includes MIT, MIT-0, Apache-2.0, BSD, ISC, BlueOak, Python-2.0, CC-BY-4.0, and LGPL-bearing packages (including platform image tooling). Optional platform binaries also appear in the lockfile; presence is not proof they ship in every deployment. Maintainers must review distribution-specific notice/source obligations, Go module licenses, Flutter plugins, fonts/icons and built application contents before release. Unspecified package license metadata must be checked at source. This is an inventory review, not legal clearance.

CloudDeck has no top-level license. This work does not select or grant one. Contributor history is preserved, and no attribution files are removed.

Fresh npm 11.9.0 installation resolves Next.js 15.5.29, Nodemailer 10.6.1 and PostCSS 8.5.28 with zero registry advisories. `npm ls` continues to label the upstream Next.js exact PostCSS edge invalid despite the explicit root overrides; this unresolved package-manager diagnostic is disclosed separately from installed-version/audit/build verification.
