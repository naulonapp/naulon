<?php
/**
 * Diagnostics — the screen that is allowed to say "this is not working".
 *
 * It leads with the cache, because a page cache is the one failure here that looks exactly like
 * success: the site is fast, nothing errors, and every crawler reads free forever. The test at
 * the top is a real HTTP request to a real article with a crawler's user agent, and its answer is
 * the only claim on this page that is evidence rather than inference.
 *
 * Everything else is arranged the same way: show what was observed, name the layer, and where the
 * plugin genuinely cannot control something — a CDN's edge cache is the standard case — say so in
 * those words instead of implying coverage that does not exist.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Admin_Diagnostics {

	/**
	 * The screen.
	 *
	 * @return void
	 */
	public static function render() {
		echo '<div class="wrap naulon-wrap">';
		Naulon_Admin::header( __( 'Diagnostics', 'naulon' ) );

		self::render_probe();
		self::render_cache();
		self::render_decisions();
		self::render_connectivity();
		self::render_data();
		self::render_environment();

		echo '</div>';
	}

	/* --------------------------------------------------------------------------------------- */
	/* The probe                                                                                */
	/* --------------------------------------------------------------------------------------- */

	/**
	 * @return void
	 */
	private static function render_probe() {
		Naulon_Admin::card_open( __( 'Is the toll actually reaching agents?', 'naulon' ) );
		echo '<p>' . esc_html__( 'This asks your site for one of its own articles with a crawler’s user agent and no cache-busting tricks — exactly what a real crawler sends. If anything between the internet and WordPress is answering from a cache, this is where it shows up.', 'naulon' ) . '</p>';

		Naulon_Admin::form_open( 'run_probe', Naulon_Admin::PAGE_DIAGNOSTICS );
		submit_button( __( 'Run the check', 'naulon' ), 'primary', 'submit', false );
		Naulon_Admin::form_close();

		$result = Naulon_Admin::take( 'probe' );
		if ( ! is_array( $result ) ) {
			Naulon_Admin::card_close();
			return;
		}

		echo '<div class="naulon-result naulon-result--' . esc_attr( (string) $result['verdict'] ) . '"><div class="naulon-state">';
		if ( 'enforcing' === $result['verdict'] ) {
			Naulon_Admin::pill( 'ok', __( 'Charged', 'naulon' ) );
		} elseif ( 'under_tolling' === $result['verdict'] ) {
			Naulon_Admin::pill( 'bad', __( 'Served free', 'naulon' ) );
		} else {
			Naulon_Admin::pill( 'warn', __( 'Could not tell', 'naulon' ) );
		}
		if ( ! empty( $result['status'] ) ) {
			printf( '<code class="naulon-token">HTTP %d</code>', (int) $result['status'] );
		}
		if ( ! empty( $result['url'] ) ) {
			printf( '<span class="naulon-muted naulon-truncate">%s</span>', esc_html( (string) $result['url'] ) );
		}
		echo '</div>';

		echo '<p>' . esc_html( (string) $result['message'] ) . '</p>';

		if ( ! empty( $result['headers'] ) ) {
			echo '<table class="naulon-kv"><tbody>';
			foreach ( (array) $result['headers'] as $name => $value ) {
				printf( '<tr><th>%s</th><td><code>%s</code></td></tr>', esc_html( (string) $name ), esc_html( (string) $value ) );
			}
			echo '</tbody></table>';
		}
		echo '</div>';

		Naulon_Admin::card_close();
	}

	/* --------------------------------------------------------------------------------------- */
	/* Caching                                                                                  */
	/* --------------------------------------------------------------------------------------- */

	/**
	 * @return void
	 */
	private static function render_cache() {
		$state  = Naulon_Cache::dropin_state();
		$layers = Naulon_Cache::layers();

		Naulon_Admin::card_open( __( 'Caching', 'naulon' ) );

		echo '<p class="naulon-state">';
		if ( $state['installed'] && $state['current'] ) {
			Naulon_Admin::pill( 'ok', __( 'Cache guard installed', 'naulon' ) );
		} elseif ( $state['installed'] ) {
			Naulon_Admin::pill( 'warn', __( 'Cache guard is an old version', 'naulon' ) );
		} else {
			Naulon_Admin::pill( 'idle', __( 'Cache guard not installed', 'naulon' ) );
		}
		echo '</p>';

		echo '<p>' . esc_html__( 'The guard is a small must-use plugin that loads before any caching plugin and marks machine requests uncacheable. It stops a paid response, or a 402, from ever being stored — which is what keeps a cached paywall from being shown to a reader.', 'naulon' ) . '</p>';
		echo '<p class="naulon-muted">' . esc_html__( 'What it cannot do, plainly: WordPress hands a request to the full-page cache before any plugin loads, so a page already in the cache is served without this plugin ever running. Stopping that needs your cache’s own user-agent exclusion list, below. The check at the top of this page is how you find out which situation you are in.', 'naulon' ) . '</p>';

		Naulon_Admin::actions_open();
		if ( $state['installed'] ) {
			if ( ! $state['current'] ) {
				Naulon_Admin::form_open( 'install_dropin', Naulon_Admin::PAGE_DIAGNOSTICS );
				submit_button( __( 'Update the guard', 'naulon' ), 'primary', 'submit', false );
				Naulon_Admin::form_close();
			}
			Naulon_Admin::form_open( 'remove_dropin', Naulon_Admin::PAGE_DIAGNOSTICS );
			submit_button( __( 'Remove the guard', 'naulon' ), 'secondary', 'submit', false );
			Naulon_Admin::form_close();
		} else {
			Naulon_Admin::form_open( 'install_dropin', Naulon_Admin::PAGE_DIAGNOSTICS );
			submit_button( __( 'Install the guard', 'naulon' ), 'primary', 'submit', false );
			Naulon_Admin::form_close();
		}
		Naulon_Admin::actions_close();
		printf( '<p class="naulon-muted naulon-hint"><code class="naulon-token">%s</code></p>', esc_html( (string) $state['path'] ) );

		echo '<h3>' . esc_html__( 'What is caching this site', 'naulon' ) . '</h3>';
		if ( empty( $layers ) ) {
			echo '<p class="naulon-muted">' . esc_html__( 'No caching layer is visible from inside WordPress. A CDN in front of the site would not be — the check at the top of this page is what tests for that.', 'naulon' ) . '</p>';
		} else {
			echo '<ul class="naulon-list">';
			foreach ( $layers as $layer ) {
				printf(
					'<li><strong>%s</strong><br /><span class="naulon-muted">%s</span></li>',
					esc_html( (string) $layer['name'] ),
					esc_html( (string) $layer['note'] )
				);
			}
			echo '</ul>';
			echo '<h3>' . esc_html__( 'User agents to exclude from your cache', 'naulon' ) . '</h3>';
			echo '<p class="naulon-muted">' . esc_html__( 'Paste these into whichever "never cache these user agents" list your caching plugin offers. They are the exact fragments this plugin charges for, so the two cannot disagree.', 'naulon' ) . '</p>';
			printf(
				'<p><textarea readonly rows="6" class="large-text code" onfocus="this.select()">%s</textarea></p>',
				esc_textarea( implode( "\n", Naulon_Cache::exclusion_fragments() ) )
			);
		}

		Naulon_Admin::card_close();
	}

	/* --------------------------------------------------------------------------------------- */
	/* Decisions                                                                                */
	/* --------------------------------------------------------------------------------------- */

	/**
	 * @return void
	 */
	private static function render_decisions() {
		$entries = Naulon_Log::recent( 25 );
		$counts  = Naulon_Log::counts();

		Naulon_Admin::card_open( __( 'Recent decisions', 'naulon' ) );
		echo '<p class="naulon-muted">' . esc_html__( 'Only machine requests are recorded. A reader’s visit is never logged here — not their address, not their browser, not the fact that they came at all.', 'naulon' ) . '</p>';

		printf(
			'<p>%s</p>',
			esc_html(
				sprintf(
					/* translators: 1: how many requests are in the window, 2: charged, 3: paid, 4: re-read with a license, 5: served free. */
					__( 'In the last %1$d machine requests: %2$d charged, %3$d paid, %4$d re-read with a license, %5$d served free.', 'naulon' ),
					count( Naulon_Log::all() ),
					$counts['pay'],
					$counts['settled'],
					$counts['reread'],
					$counts['free']
				)
			)
		);

		if ( empty( $entries ) ) {
			echo '<p class="naulon-muted">' . esc_html__( 'No machine has asked for an article yet.', 'naulon' ) . '</p>';
			Naulon_Admin::card_close();
			return;
		}

		echo '<table class="widefat striped naulon-table"><thead><tr>';
		printf( '<th>%s</th>', esc_html__( 'When', 'naulon' ) );
		printf( '<th>%s</th>', esc_html__( 'Outcome', 'naulon' ) );
		printf( '<th>%s</th>', esc_html__( 'Article', 'naulon' ) );
		printf( '<th>%s</th>', esc_html__( 'Why', 'naulon' ) );
		printf( '<th>%s</th>', esc_html__( 'Asked by', 'naulon' ) );
		echo '</tr></thead><tbody>';
		foreach ( $entries as $entry ) {
			echo '<tr>';
			printf(
				'<td>%s</td>',
				esc_html(
					sprintf(
						/* translators: %s: human time difference. */
						__( '%s ago', 'naulon' ),
						human_time_diff( (int) $entry['at'], time() )
					)
				)
			);
			printf( '<td>%s</td>', esc_html( self::outcome_label( (string) $entry['action'] ) ) );
			printf( '<td><code>%s</code></td>', esc_html( (string) $entry['slug'] ) );
			printf( '<td class="naulon-muted">%s</td>', esc_html( (string) $entry['reason'] ) );
			printf( '<td class="naulon-muted">%s</td>', esc_html( (string) $entry['ua'] ) );
			echo '</tr>';
		}
		echo '</tbody></table>';

		Naulon_Admin::form_open( 'clear_log', Naulon_Admin::PAGE_DIAGNOSTICS );
		submit_button( __( 'Clear', 'naulon' ), 'link', 'submit', false );
		Naulon_Admin::form_close();

		Naulon_Admin::card_close();
	}

	/**
	 * @param string $action Decision action.
	 * @return string
	 */
	private static function outcome_label( $action ) {
		switch ( $action ) {
			case 'pay':
				return __( 'charged', 'naulon' );
			case 'settled':
				return __( 'paid', 'naulon' );
			case 'reread':
				return __( 're-read with a license', 'naulon' );
			default:
				return __( 'served free', 'naulon' );
		}
	}

	/* --------------------------------------------------------------------------------------- */
	/* Connectivity + environment                                                               */
	/* --------------------------------------------------------------------------------------- */

	/**
	 * @return void
	 */
	private static function render_connectivity() {
		$settings = Naulon_Settings::all();
		$next     = wp_next_scheduled( Naulon_Cron::EVENT );

		Naulon_Admin::card_open( __( 'Control plane', 'naulon' ) );
		echo '<table class="naulon-kv"><tbody>';
		self::kv( __( 'Address', 'naulon' ), Naulon_Settings::api_base() );
		self::kv( __( 'Key', 'naulon' ), '' !== Naulon_Settings::api_key() ? Naulon_Key::mask( Naulon_Settings::api_key() ) : __( 'none', 'naulon' ) );
		self::kv( __( 'Verified host', 'naulon' ), Naulon_Settings::is_verified() ? Naulon_Verification::host() : __( 'not verified', 'naulon' ) );
		self::kv_html( __( 'Last status check', 'naulon' ), Naulon_Admin::when( (string) $settings['status_checked_at'], __( 'never', 'naulon' ) ) );
		self::kv( __( 'This domain is classified as', 'naulon' ), '' !== (string) $settings['status_mode'] ? (string) $settings['status_mode'] : __( 'not classified yet', 'naulon' ) );
		if ( '' !== (string) $settings['status_error'] ) {
			self::kv( __( 'Last status error', 'naulon' ), (string) $settings['status_error'] );
		}
		self::kv_html( __( 'Last heartbeat', 'naulon' ), Naulon_Admin::when( (string) $settings['heartbeat_at'], __( 'never', 'naulon' ) ) );
		// Only when it says something the status error did not: the two share a cause more often
		// than not, and printing the same sentence twice makes a screen look broken.
		if ( '' !== (string) $settings['heartbeat_note'] && (string) $settings['heartbeat_note'] !== (string) $settings['status_error'] ) {
			self::kv( __( 'Heartbeat note', 'naulon' ), (string) $settings['heartbeat_note'] );
		}
		self::kv(
			__( 'Next heartbeat', 'naulon' ),
			false !== $next
				/* translators: %s: human time difference. */
				? sprintf( __( 'in %s', 'naulon' ), human_time_diff( time(), (int) $next ) )
				: __( 'not scheduled', 'naulon' )
		);
		echo '</tbody></table>';
		echo '<p class="naulon-muted">' . esc_html__( 'The heartbeat prices one real article every hour. That is what keeps your account from marking this site as a dead integration during a quiet week, and it is how a conflict with DNS-based enforcement is noticed.', 'naulon' ) . '</p>';
		Naulon_Admin::card_close();
	}

	/**
	 * @return void
	 */
	private static function render_environment() {
		global $wp_rewrite;

		Naulon_Admin::card_open( __( 'This installation', 'naulon' ) );
		echo '<table class="naulon-kv"><tbody>';
		self::kv( __( 'Site address', 'naulon' ), home_url() );
		self::kv( __( 'Served over HTTPS', 'naulon' ), Naulon_Verification::is_https() ? __( 'yes', 'naulon' ) : __( 'no — ownership cannot be verified without it', 'naulon' ) );
		self::kv(
			__( 'Permalinks', 'naulon' ),
			Naulon_Verification::permalinks_ok()
				? (string) get_option( 'permalink_structure' )
				: __( 'plain — nothing can be tolled, and the ownership challenge cannot be served', 'naulon' )
		);
		self::kv( __( 'PHP', 'naulon' ), PHP_VERSION );
		self::kv( __( 'WordPress', 'naulon' ), get_bloginfo( 'version' ) );
		self::kv( __( 'Plugin', 'naulon' ), self::plugin_version_line() );
		self::kv( __( 'WP-Cron', 'naulon' ), ( defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON ) ? __( 'disabled — run it from the system scheduler, or the heartbeat will not fire', 'naulon' ) : __( 'enabled', 'naulon' ) );
		echo '</tbody></table>';

		$token = (string) Naulon_Settings::all()['challenge_token'];
		if ( '' !== $token ) {
			$probe = Naulon_Verification::self_probe( Naulon_Challenge::challenge_url( $token ) );
			echo '<h3>' . esc_html__( 'Ownership challenge, as this server sees it', 'naulon' ) . '</h3>';
			echo '<table class="naulon-kv"><tbody>';
			self::kv( __( 'URL', 'naulon' ), Naulon_Challenge::challenge_url( $token ) );
			self::kv( __( 'Status', 'naulon' ), 0 === $probe['status'] ? $probe['error'] : (string) $probe['status'] );
			self::kv( __( 'Body', 'naulon' ), '' === trim( $probe['body'] ) ? __( '(empty)', 'naulon' ) : substr( trim( $probe['body'] ), 0, 120 ) );
			if ( '' !== $probe['location'] ) {
				self::kv( __( 'Redirects to', 'naulon' ), $probe['location'] );
			}
			echo '</tbody></table>';
		}

		Naulon_Admin::card_close();
	}

	/**
	 * The installed version, and whether a newer one is waiting.
	 *
	 * A bare version number answers "which build is this" but not the question an administrator on
	 * a diagnostics screen is actually asking — "am I looking at a bug that is already fixed".
	 * Both readings come from the update transient core maintains, so this reports exactly what the
	 * Plugins screen would offer and never performs a check of its own: a diagnostics page that
	 * fires an HTTP request on every load is slow precisely when the network is the thing being
	 * diagnosed.
	 *
	 * @return string
	 */
	private static function plugin_version_line() {
		$updates = get_site_transient( 'update_plugins' );
		$file    = plugin_basename( NAULON_PLUGIN_FILE );

		$offered = isset( $updates->response[ $file ]->new_version )
			? (string) $updates->response[ $file ]->new_version
			: '';

		if ( '' !== $offered ) {
			return sprintf(
				/* translators: 1: installed version, 2: the newer version available. */
				__( '%1$s — %2$s is available, install it from the Plugins screen', 'naulon' ),
				NAULON_VERSION,
				$offered
			);
		}

		// Present in `no_update` means a check ran and this IS the current version. Absent from
		// both means no check has completed yet — not the same thing, and saying "up to date"
		// there would be a claim nothing has verified.
		if ( isset( $updates->no_update[ $file ] ) ) {
			return sprintf(
				/* translators: %s: installed version. */
				__( '%s — up to date', 'naulon' ),
				NAULON_VERSION
			);
		}

		return sprintf(
			/* translators: %s: installed version. */
			__( '%s — no update check has completed yet', 'naulon' ),
			NAULON_VERSION
		);
	}

	/**
	 * One key/value row.
	 *
	 * @param string $key   Label.
	 * @param string $value Value.
	 * @return void
	 */
	private static function kv( $key, $value ) {
		printf( '<tr><th>%s</th><td>%s</td></tr>', esc_html( $key ), esc_html( (string) $value ) );
	}

	/**
	 * The same row, for a value that is already escaped markup.
	 *
	 * @param string $key   Label.
	 * @param string $value Escaped HTML.
	 * @return void
	 */
	private static function kv_html( $key, $value ) {
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $value is built by Naulon_Admin::when(), which escapes.
		printf( '<tr><th>%s</th><td>%s</td></tr>', esc_html( $key ), $value );
	}

	/* --------------------------------------------------------------------------------------- */
	/* Your data if this plugin is deleted                                                      */
	/* --------------------------------------------------------------------------------------- */

	/**
	 * The choice that used to be made for you, moved to where it can be made deliberately.
	 *
	 * WordPress runs a plugin's uninstall BEFORE it removes the files, so Delete is one click with
	 * no undo and core's generic "files and data" as its only warning. This card states what would
	 * be destroyed, in counts, and defaults to destroying none of it.
	 *
	 * @return void
	 */
	private static function render_data() {
		$inventory = Naulon_Data::inventory();
		$purge     = Naulon_Data::should_purge( Naulon_Settings::all() );

		Naulon_Admin::card_open( __( 'Your data if this plugin is deleted', 'naulon' ) );

		echo '<p class="naulon-state">';
		if ( $purge ) {
			Naulon_Admin::pill( 'bad', __( 'Deleting the plugin will erase this data', 'naulon' ) );
		} else {
			Naulon_Admin::pill( 'ok', __( 'Deleting the plugin keeps this data', 'naulon' ) );
		}
		echo '</p>';

		echo '<table class="naulon-kv"><tbody>';
		self::kv( __( 'Author wallet addresses', 'naulon' ), (string) number_format_i18n( $inventory['wallets'] ) );
		self::kv(
			__( 'Settlements recorded', 'naulon' ),
			sprintf(
				/* translators: 1: number of settlements, 2: total in USDC. */
				__( '%1$s — %2$s USDC settled', 'naulon' ),
				number_format_i18n( $inventory['settlements'] ),
				$inventory['settled_total']
			)
		);
		self::kv( __( 'Posts with a toll choice saved', 'naulon' ), (string) number_format_i18n( $inventory['tolled_posts'] ) );
		echo '</tbody></table>';

		echo '<p>' . esc_html__( 'WordPress removes a plugin\'s data before it removes its files, and it cannot be undone. By default this plugin keeps everything above when you delete it, so a mistaken Delete costs you nothing but a reinstall. Our own code goes either way: the cache guard and the hourly schedule are removed, because leaving them running for a plugin that is gone is a bug.', 'naulon' ) . '</p>';

		if ( $purge ) {
			echo '<p class="naulon-muted">' . esc_html__( 'You have asked for full removal. Export first — the wallet addresses were typed in by hand, and the settlement record is the only copy outside the chain.', 'naulon' ) . '</p>';
		}

		Naulon_Admin::actions_open();

		Naulon_Admin::form_open( 'export_data', Naulon_Admin::PAGE_DIAGNOSTICS );
		submit_button( __( 'Export wallets and earnings', 'naulon' ), 'secondary', 'submit', false );
		Naulon_Admin::form_close();

		Naulon_Admin::form_open( 'save_data_policy', Naulon_Admin::PAGE_DIAGNOSTICS );
		printf(
			'<label class="naulon-inline"><input type="checkbox" name="purge_on_uninstall" value="1" %s /> %s</label> ',
			checked( $purge, true, false ),
			esc_html__( 'Also erase my data when this plugin is deleted', 'naulon' )
		);
		submit_button( __( 'Save', 'naulon' ), 'secondary', 'submit', false );
		Naulon_Admin::form_close();

		Naulon_Admin::actions_close();

		// The failure that motivated all of the above: a plugin directory the web server cannot
		// write to cannot be updated OR deleted, and core reports it as a wall of unwritable
		// filenames without ever mentioning ownership.
		$unwritable = Naulon_Data::first_unwritable_dir();
		if ( '' !== $unwritable ) {
			echo '<p class="naulon-state">';
			Naulon_Admin::pill( 'bad', __( 'WordPress cannot update or delete this plugin', 'naulon' ) );
			echo '</p>';
			echo '<p>' . sprintf(
				/* translators: %s: absolute directory path. */
				esc_html__( '%s is not writable by the web server, and removing or replacing a file needs write permission on the directory that holds it — not on the file. Until that is fixed, an update will report that files could not be copied and a delete will report that the plugin could not be fully removed. It usually means the plugin was installed by a different user (over SSH, or as root), so the fix is to give the directory back to the user PHP runs as.', 'naulon' ),
				'<code>' . esc_html( $unwritable ) . '</code>'
			) . '</p>';
		}

		Naulon_Admin::card_close();
	}

	/* --------------------------------------------------------------------------------------- */
	/* Actions                                                                                  */
	/* --------------------------------------------------------------------------------------- */

	/**
	 * @param string $action Which button was pressed.
	 * @return void
	 */
	public static function handle( $action ) {
		switch ( $action ) {
			case 'install_dropin':
				$result = Naulon_Cache::install_dropin();
				Naulon_Admin::notice( $result['ok'] ? 'success' : 'error', $result['message'] );
				break;
			case 'remove_dropin':
				$result = Naulon_Cache::remove_dropin();
				Naulon_Admin::notice( $result['ok'] ? 'success' : 'error', $result['message'] );
				break;
			case 'run_probe':
				$result = Naulon_Cache::probe();
				unset( $result['challenge'] );
				Naulon_Admin::carry( 'probe', $result );
				Naulon_Admin::notice( $result['ok'] ? 'success' : 'warning', (string) $result['message'] );
				break;
			case 'clear_log':
				Naulon_Log::clear();
				Naulon_Admin::notice( 'success', __( 'Cleared.', 'naulon' ) );
				break;
			case 'save_data_policy':
				self::save_data_policy();
				break;
			case 'export_data':
				self::export_data();
				break;
		}
	}

	/**
	 * Store the delete-time data policy. Read as a checkbox, so absence means "keep" — the safe
	 * direction, and the direction an unchecked box actually means.
	 *
	 * @return void
	 */
	private static function save_data_policy() {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- Naulon_Admin::handle() ran check_admin_referer for this action before dispatching.
		$purge = isset( $_POST['purge_on_uninstall'] ) && '1' === sanitize_text_field( wp_unslash( $_POST['purge_on_uninstall'] ) );

		Naulon_Settings::update( array( Naulon_Data::PURGE_SETTING => $purge ) );

		Naulon_Admin::notice(
			$purge ? 'warning' : 'success',
			$purge
				? __( 'Saved. Deleting the plugin will now erase your wallets and earnings record — export a copy first.', 'naulon' )
				: __( 'Saved. Deleting the plugin will keep your wallets and earnings record.', 'naulon' )
		);
	}

	/**
	 * Stream the export as a download and stop.
	 *
	 * Never written to disk: a file of payout addresses under `wp-content/uploads/` sits at a
	 * guessable URL, which is a worse problem than the one the export solves. `exit` is required
	 * because the dispatcher redirects back to the screen after every other action.
	 *
	 * @return void
	 */
	private static function export_data() {
		$payload = Naulon_Data::export_payload();
		$body    = wp_json_encode( $payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
		$name    = 'naulon-export-' . gmdate( 'Y-m-d' ) . '.json';

		nocache_headers();
		header( 'Content-Type: application/json; charset=utf-8' );
		header( 'Content-Disposition: attachment; filename="' . $name . '"' );
		header( 'Content-Length: ' . strlen( (string) $body ) );
		echo $body; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- a JSON download body, already encoded by wp_json_encode.
		exit;
	}
}
