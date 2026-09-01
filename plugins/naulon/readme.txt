=== naulon — citation toll ===
Contributors: naulon
Tags: ai crawlers, gptbot, monetization, paywall, licensing
Requires at least: 6.2
Tested up to: 7.0
Requires PHP: 7.4
Stable tag: 0.5.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Charge AI agents for reading your articles. Humans always read free, and your authors get paid directly.

== Description ==

AI agents read your work to answer questions. They do not click your ads, they do not subscribe, and they rarely send a reader back. naulon prices that read.

A human visitor is never affected. They see exactly what they always saw, at the same speed. An automated agent asking for the full text of an article gets a price instead, pays it, and then reads. What it pays goes to the people credited on that article — straight to their wallets, with nothing pooled or held in between.

**How it decides**

* Human traffic reads free. This is not a setting and there is no switch to change it.
* Titles, excerpts, your sitemap and your feeds stay free — agents need to find you.
* Full article text is what carries a price.
* An article with no wallet behind it reads free. Nothing is ever charged with nowhere to send it.

**What you configure**

You paste one key, click verify, and choose what is tolled. Your authors each add their own wallet address from their normal WordPress profile — an author never sees anyone else's earnings, and only editors and administrators can see the site's total.

**How you know it is working**

The Setup screen has a **Test toll** button that asks your own site for one of your articles while presenting a crawler's user agent, over real HTTP, and shows you what came back: the status, the price, the chain, and the wallet being paid. Diagnostics runs the same check against caching, lists the last decisions the toll made — machine requests only, readers are never logged — and says plainly when something between the internet and WordPress is answering from a cache.

**Where the money goes**

Payment is direct: the agent pays your authors. This plugin never takes custody of funds, never holds a balance, and never asks you to top anything up. There is no wallet on this site holding money.

**Self-hosting**

The whole protocol is open source. The connectivity field takes either a hosted key or the URL of a gate you run yourself, and everything else works identically.

== Installation ==

1. Install and activate the plugin from **Plugins → Add New**. Later versions arrive on the Plugins screen like any other update.
2. Open **naulon → Setup** and paste your key.
3. Click **Verify this site**. The plugin proves you own the domain by serving a challenge file and a meta tag — no DNS changes needed.
4. Paste the credits address shown on that screen into your naulon account, so the service knows where to read your author data.
5. Switch the toll on, and press **Test toll** to watch a crawler get charged.
6. Choose what is tolled under **naulon → Content**.
7. Ask your authors to add a wallet address to their profile. Posts by authors without one read free.

Permalinks must not be set to Plain — with plain permalinks an article has no address to identify it by, and nothing can be tolled. The Setup screen says so if that is the case.

If anything caches pages on your site, install the cache guard from **naulon → Diagnostics**. A cached article is served before any plugin runs, so without it crawlers can read from the cache for free.

For the strongest key storage, add it to `wp-config.php` instead of the settings screen:

`define( 'NAULON_API_KEY', 'nln_live_…' );`

A key in `wp-config.php` stays out of your database, so it does not travel in database exports or backups. The settings screen will tell you which storage is in use.

== External services ==

This plugin relies on an external service to price a read and to settle a payment, because
settlement cannot be performed inside WordPress. Nothing is contacted until you enter a key —
entering it is the consent, and until then the plugin makes no outbound requests at all —
not one, to anywhere.

**Service:** naulon (https://naulon.app), reached at https://gate.naulon.app.

**When it is contacted, and what is sent:**

* When you connect or rotate a key, and hourly thereafter, to confirm the connection is live.
  Sent: your API key and your site's domain.
* When you verify ownership of your site. Sent: your API key and your site's domain. The
  service then fetches a challenge file or your homepage to confirm you control the domain.
* When an automated agent requests a full article and a price is needed. Sent: your API key,
  the URL and slug of the requested article.
* When an agent pays. Sent: your API key, the article URL, the payment the agent signed, and
  the wallet addresses credited on that article.

**What is never sent:** your article content, your readers, your visitor logs, and anything
about human traffic. Human requests never contact the service at all.

If you point the connectivity field at your own self-hosted gate instead of a key, the plugin
talks only to that server and never to naulon.app.

Terms of service: https://naulon.app/terms
Privacy policy: https://naulon.app/privacy

== Frequently Asked Questions ==

= Will this slow down or break my site for readers? =

No. Human requests are not touched, and if the control plane is unreachable the plugin serves everything normally rather than failing. A plugin that breaks a site is a plugin nobody keeps.

= Do I need to understand crypto to use this? =

You need a wallet address to receive payments — the same way you would need a bank account number. Nothing else.

= What if my authors do not have wallets? =

Their posts read free. That is the deliberate behaviour: nothing is charged when there is nobody to pay.

= Does this block search engines? =

No. Search crawlers reading titles, excerpts and feeds are unaffected, and those surfaces are free by design.

= I already sell memberships. Will readers be charged twice? =

No. Content behind a membership plugin is excluded, and there is a filter (`naulon_is_tollable`) for anything custom.

= Does the plugin send my content anywhere? =

No. Your content never leaves your server. The plugin talks to the control plane only to price a read and to settle a payment, and it does not contact anything at all until you enter a key.

= Does it log my visitors? =

No. Human requests are never recorded — not their address, not their browser, not the fact that they arrived. The Diagnostics screen lists recent decisions, and every line on it is a machine.

= What happens to my data if I delete the plugin? =

It stays. Your authors' wallet addresses, your earnings record and your settings survive a delete, so reinstalling puts you back where you were. Only our own code goes: the cache guard drop-in and the hourly schedule, because leaving those running for a plugin that no longer exists is a bug.

If you do want everything removed, **naulon → Diagnostics** has a box for it, next to a count of exactly what it would destroy and a button to export a copy first. That order is deliberate — WordPress removes a plugin's data before it removes the plugin's files, and it cannot be undone.

= WordPress says it could not fully remove, or could not copy, the plugin's files =

The plugin's folder is not writable by the user your web server runs as. Removing or replacing a file needs write permission on the folder holding it, not on the file, so one folder owned by someone else stops both updates and deletion. It usually means the plugin was installed by a different user — over SSH, or as root. **naulon → Diagnostics** names the exact folder; fix its ownership and both work again.

= How do I update the plugin? =

The same way as any other: **Dashboard → Updates**, or the notice on the Plugins screen. Turning on "Enable auto-updates" there works too, and nothing about this plugin needs you to treat it differently.

= I use a caching plugin. Does that matter? =

Yes, and the plugin is direct about it. A page cache answers before any plugin runs, so a cached article can be handed to a crawler for free. Install the cache guard from Diagnostics — it stops agent responses being cached at all — then add the listed user agents to your caching plugin's own exclusion list, and use the check on that screen to confirm a crawler is actually being charged.

== Screenshots ==

1. Setup — connect, verify, switch on, and test the toll against your own site.
2. Content — choose what is tolled and which machines are charged.
3. People — which authors have wallets, and how many posts read free without one.
4. Earnings — what has been paid, per author, settled and authorized shown separately.
5. Diagnostics — the caching check, recent decisions, and connection health.

== Changelog ==

= 0.5.0 =
* Your site now publishes its licence. RSL — Really Simple Licensing — is the open standard AI crawlers are starting to check before they read: a machine-readable statement of what a site permits and what it costs. Yours is served at /license.xml, pointed at from robots.txt and from the head of every page, and built from the price and scope already in your naulon account. Nothing to write and nothing to configure.
* Search indexers stay free in the licence, because they are free at the toll. What the document says and what the plugin does are the same thing, from the same settings.
* The licence is refreshed in the background, so a price change reaches crawlers within hours without you republishing anything. If naulon cannot be reached, the licence already published stays up rather than disappearing.

= 0.4.3 =
* Your dashboard now shows what the toll actually did. Every decision the plugin makes about a crawler — charged, served free, or re-read on a license it already paid for — is reported to your naulon account, so the Audit and Readiness screens stop telling a working site that nothing has been priced yet. Readers are still never reported: not sampled, not counted, not touched.
* Settlements are not reported from here. What you were paid is recorded from the payment itself, so nothing on your earnings screen can come from this plugin claiming it.
* A report that cannot be delivered — a timeout, or your site being offline for a moment — is kept and sent with the next one, rather than lost.

= 0.4.2 =
* Three more agent user-agents are now charged: Meta's external fetcher, Amazon's user-triggered fetcher and Mistral's. They were reading your articles for free because the plugin only knew one of Meta's five tokens. Search indexers are still never charged.

= 0.4.1 =
* The update details window showed the plugin's name twice, once over the top of the other. Fixed.

= 0.4.0 =
* **Deleting the plugin no longer erases your data.** WordPress removes a plugin's data before it removes its files, so a delete that fails can still have wiped everything — and it did, on a real site. Your authors' wallet addresses and your earnings record now survive a delete, and full removal is a box you tick in advance, on a screen that shows what it would destroy.
* Export your wallets and earnings to a file from **naulon → Diagnostics**, so nothing is one click from gone.
* Diagnostics now tells you if the plugin's own folder is not writable by your web server — the reason an update reports that files could not be copied, or a delete reports that the plugin could not be fully removed. It names the folder and what to fix.

= 0.3.0 =
* Updates now arrive in WordPress. The Plugins screen tells you when a new version is out, updates in one click, and can update itself — no downloading a zip and uploading it over the top.
* The details link on that notice opens the real changelog, so you can read what changed before you take it.

= 0.2.3 =
* A shared cache could hand a crawler the copy it made for a human, so a read that should have been paid was served free. The cache guard now varies on what the toll actually decides on.
* The toll test named two wrong causes and never the real one — a network edge in front of your site turning the crawler away before it ever reaches WordPress. It now names that, and what to change.
* The version in the plugin header, the readme and the code is checked against the last release, so a build can no longer ship under a version you already have.

= 0.2.0 =
* Refuse in-app enforcement on a domain the naulon fleet already tolls, so one read is never charged twice.
* Reconcile ownership on the hourly heartbeat: a proof withdrawn in the dashboard now stands the toll down here.
* A spent connect key reads as finished instead of failing — the key drops its domain-management scope once the domain verifies.
* Clearer message when a key cannot claim domains, naming the key preset that can.

= 0.1.0 =
* First release: credits contract, author wallets, site ownership verification, roles and capabilities.
* Admin screens: setup with one-click verification and a real toll test, content policy, author payouts, earnings, diagnostics.
* Cache guard drop-in, plus a live check that tells you whether a crawler is actually being charged.
* Hourly heartbeat that keeps the connection alive and stands the toll down if DNS-based enforcement is already charging for the same domain.

== Upgrade Notice ==

= 0.5.0 =
Your site now states its terms where a crawler looks for them: /license.xml, a line in robots.txt, and a link in every page head. Built from the price you already set — nothing to configure.

= 0.4.3 =
Your naulon account now sees what the toll actually did — every crawler charged, served free, or re-reading on a license it paid for. Before this, an in-app site's Audit page could only ever show what someone else saw, which was nothing. Readers are still never reported.

= 0.4.2 =
Meta's external fetcher, Amazon's user-triggered fetcher and Mistral's were reading your articles free. This charges them. Nothing else changes.

= 0.4.1 =
Cosmetic only: the update details window no longer prints the plugin's name over itself.

= 0.4.0 =
Deleting the plugin used to erase your authors' wallets and your earnings record, before it removed any files — so a delete that appeared to fail had already destroyed them. It now keeps your data unless you tick a box asking otherwise, and you can export it first.

= 0.3.0 =
The last update you have to install by hand. From here WordPress offers new versions on the Plugins screen and can install them for you.

= 0.2.3 =
Stops a shared cache serving a paid read for free, and the toll test now names an edge block instead of two wrong causes.

= 0.2.0 =
Stops a domain being charged twice when the fleet already tolls it, and notices when you withdraw a domain proof.

= 0.1.0 =
First release.
