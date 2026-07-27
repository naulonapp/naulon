<?php
/**
 * Uninstall — the only path that removes data.
 *
 * Deactivation deliberately keeps everything: a publisher who deactivates to debug a theme
 * conflict must not lose their authors' wallet addresses. Uninstall is the explicit "remove
 * this plugin and its data" action, so it removes the settings, the capabilities, and the
 * per-user wallets.
 *
 * Wallets are the sensitive part. Leaving them behind would strand payout addresses in a
 * database nobody is watching any more, which is worse than deleting them — an author can
 * always paste their address again.
 *
 * @package naulon
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

if ( ! defined( 'NAULON_PLUGIN_DIR' ) ) {
	define( 'NAULON_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
}

require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-settings.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-roles.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-credits.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-wallet.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-agent.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-ledger.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-log.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-cache.php';
require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-cron.php';

Naulon_Settings::delete_all();
Naulon_Roles::remove_capabilities();
Naulon_Log::clear();

// The earnings ledger goes too. It is a record of money, so this is the one deletion worth
// hesitating over — but a table left behind in a database nobody is watching is not a record
// anybody can use, and the settlements themselves are on chain, which is the copy that lasts.
Naulon_Ledger::drop();

// The must-use cache guard is ours; leaving it would leave a file running on a site that no
// longer has the plugin it belongs to.
$naulon_dropin = Naulon_Cache::dropin_path();
if ( file_exists( $naulon_dropin ) ) {
	wp_delete_file_from_directory( $naulon_dropin, dirname( $naulon_dropin ) );
}

// Stop the heartbeat before the code that answers it disappears.
Naulon_Cron::instance()->unschedule();

delete_metadata( 'user', 0, Naulon_Credits::USER_WALLET_META, '', true );
delete_post_meta_by_key( Naulon_Credits::POST_TOLL_META );
