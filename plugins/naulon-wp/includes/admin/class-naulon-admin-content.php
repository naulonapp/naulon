<?php
/**
 * Content — what gets tolled, and which machines get charged for it.
 *
 * There is no price on this screen, and that is deliberate rather than unfinished. The price
 * comes from the control plane's own resolver, which is the single place it is decided; a field
 * here would be a second source of truth for money, and the one that is wrong.
 *
 * What a publisher genuinely owns is on this screen instead: which post types are in scope,
 * which individual posts are exempt, and the two user-agent lists that override the built-in
 * classification in either direction. The allow list wins over the charge list, always — a
 * publisher who needs a crawler for indexing must never be able to charge it by accident.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Admin_Content {

	/**
	 * The screen.
	 *
	 * @return void
	 */
	public static function render() {
		$settings = Naulon_Settings::all();
		$credits  = Naulon_Credits::instance();

		echo '<div class="wrap naulon-wrap">';
		Naulon_Admin::header( __( 'Content', 'naulon' ) );

		self::render_scope( $credits );
		self::render_policy( $settings );
		self::render_token( $settings );

		echo '</div>';
	}

	/**
	 * What is in scope right now — as counted, not as claimed.
	 *
	 * @param Naulon_Credits $credits The credits service.
	 * @return void
	 */
	private static function render_scope( $credits ) {
		$counts = self::scope_counts( $credits );

		Naulon_Admin::card_open( __( 'What can be tolled', 'naulon' ) );
		printf(
			'<p>%s <code>%s</code></p>',
			esc_html__( 'Post types in scope:', 'naulon' ),
			esc_html( implode( ', ', $credits->tollable_post_types() ) )
		);
		echo '<p class="naulon-muted">' . esc_html__( 'Pages are out of scope by default — an About page is not the article an agent is citing. A theme or a small snippet can change this through the naulon_tollable_post_types filter.', 'naulon' ) . '</p>';

		echo '<table class="naulon-kv"><tbody>';
		printf(
			'<tr><th>%s</th><td class="naulon-num">%s</td></tr>',
			esc_html__( 'Published', 'naulon' ),
			esc_html( number_format_i18n( $counts['published'] ) )
		);
		printf(
			'<tr><th>%s</th><td class="naulon-num"><strong>%s</strong></td></tr>',
			esc_html__( 'Chargeable now', 'naulon' ),
			esc_html( number_format_i18n( $counts['tollable'] ) )
		);
		printf(
			'<tr><th>%s</th><td class="naulon-num">%s</td></tr>',
			esc_html__( 'Free: no author wallet', 'naulon' ),
			esc_html( number_format_i18n( $counts['no_wallet'] ) )
		);
		printf(
			'<tr><th>%s</th><td class="naulon-num">%s</td></tr>',
			esc_html__( 'Free: marked free by an editor', 'naulon' ),
			esc_html( number_format_i18n( $counts['opted_out'] ) )
		);
		echo '</tbody></table>';

		if ( $counts['no_wallet'] > 0 ) {
			printf(
				'<p class="naulon-warn">%s <a href="%s">%s</a></p>',
				esc_html(
					sprintf(
						/* translators: %d: number of posts. */
						_n(
							'%d published post reads free because its author has no wallet.',
							'%d published posts read free because their authors have no wallet.',
							$counts['no_wallet'],
							'naulon'
						),
						$counts['no_wallet']
					)
				),
				esc_url( admin_url( 'admin.php?page=' . Naulon_Admin::PAGE_PEOPLE ) ),
				esc_html__( 'Fix that on the People screen.', 'naulon' )
			);
		}

		echo '<p class="naulon-muted">' . esc_html__( 'Every post has a naulon box in the editor sidebar for marking that one article free.', 'naulon' ) . '</p>';
		Naulon_Admin::card_close();
	}

	/**
	 * Count what is actually chargeable. Bounded: a site with 50,000 posts must not turn an admin
	 * screen into a table scan, so the count is over a recent window and says so.
	 *
	 * @param Naulon_Credits $credits The credits service.
	 * @return array{published:int, tollable:int, no_wallet:int, opted_out:int, window:int}
	 */
	public static function scope_counts( $credits ) {
		$window = 500;
		$posts  = get_posts(
			array(
				'post_type'        => $credits->tollable_post_types(),
				'post_status'      => 'publish',
				'numberposts'      => $window,
				'suppress_filters' => false,
			)
		);

		$counts = array(
			'published'  => count( $posts ),
			'tollable'   => 0,
			'no_wallet'  => 0,
			'opted_out'  => 0,
			'window'     => $window,
		);

		foreach ( $posts as $post ) {
			if ( ! $credits->is_tollable( $post ) ) {
				++$counts['opted_out'];
				continue;
			}
			if ( empty( $credits->contributors_for( $post ) ) ) {
				++$counts['no_wallet'];
				continue;
			}
			++$counts['tollable'];
		}

		return $counts;
	}

	/**
	 * The two user-agent lists.
	 *
	 * @param array $settings Settings.
	 * @return void
	 */
	private static function render_policy( array $settings ) {
		Naulon_Admin::card_open( __( 'Which machines are charged', 'naulon' ) );

		echo '<p>' . esc_html__( 'Out of the box, obvious training crawlers and assistant fetchers are charged, search indexers are not, and anything ambiguous reads free. A human is never charged under any setting.', 'naulon' ) . '</p>';

		Naulon_Admin::form_open( 'save_content', Naulon_Admin::PAGE_CONTENT );

		echo '<h3>' . esc_html__( 'Always free', 'naulon' ) . '</h3>';
		echo '<p class="naulon-muted">' . esc_html__( 'One fragment of a user agent per line. Anything matching reads free, even if it also looks like a bot. This list wins over the one below.', 'naulon' ) . '</p>';
		printf(
			'<p><textarea name="naulon_seo_allowlist" rows="4" class="large-text code" placeholder="%s">%s</textarea></p>',
			esc_attr( "yandex\nsome-partner-crawler" ),
			esc_textarea( implode( "\n", (array) $settings['seo_allowlist'] ) )
		);

		echo '<h3>' . esc_html__( 'Always charged', 'naulon' ) . '</h3>';
		echo '<p class="naulon-muted">' . esc_html__( 'One fragment per line. Use this for a crawler the built-in list does not know about yet.', 'naulon' ) . '</p>';
		printf(
			'<p><textarea name="naulon_charge_list" rows="4" class="large-text code" placeholder="%s">%s</textarea></p>',
			esc_attr( 'some-new-ai-crawler' ),
			esc_textarea( implode( "\n", (array) $settings['charge_list'] ) )
		);

		submit_button( __( 'Save', 'naulon' ), 'primary', 'submit', false );
		Naulon_Admin::form_close();

		echo '<h3>' . esc_html__( 'Charged by default', 'naulon' ) . '</h3>';
		echo '<div class="naulon-tags">';
		foreach ( Naulon_Agent::KNOWN_AGENT_UA as $fragment ) {
			printf( '<span class="naulon-tag">%s</span>', esc_html( $fragment ) );
		}
		echo '</div>';
		Naulon_Admin::card_close();
	}

	/**
	 * The optional shared token on the credits route.
	 *
	 * @param array $settings Settings.
	 * @return void
	 */
	private static function render_token( array $settings ) {
		Naulon_Admin::card_open( __( 'Credits route', 'naulon' ) );
		printf(
			'<p><code>%s</code></p>',
			esc_html( rest_url( Naulon_Credits::NAMESPACE_V1 . '/credits/' ) )
		);
		echo '<p class="naulon-muted">' . esc_html__( 'This route describes published articles and their payees, and nothing else — a draft or a private post answers 404 exactly like a post that does not exist. It is open by default because the control plane calls it from another host. A shared token is available if you would rather it were not open; set the same value on your account.', 'naulon' ) . '</p>';

		Naulon_Admin::form_open( 'save_content', Naulon_Admin::PAGE_CONTENT );
		echo '<div class="naulon-field">';
		echo '<label for="naulon_credits_token">' . esc_html__( 'Shared token (leave empty to keep the route open)', 'naulon' ) . '</label>';
		printf(
			'<input type="text" class="regular-text code" id="naulon_credits_token" name="naulon_credits_token" value="%s" autocomplete="off" />',
			esc_attr( (string) $settings['credits_token'] )
		);
		echo '<input type="hidden" name="naulon_token_only" value="1" />';
		submit_button( __( 'Save token', 'naulon' ), 'secondary', 'submit', false );
		echo '</div>';
		Naulon_Admin::form_close();
		Naulon_Admin::card_close();
	}

	/**
	 * Save the policy lists and/or the token.
	 *
	 * @return void
	 */
	public static function save() {
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- the dispatcher checked it.
		$token_only = isset( $_POST['naulon_token_only'] );

		if ( $token_only ) {
			$token = isset( $_POST['naulon_credits_token'] ) ? sanitize_text_field( wp_unslash( $_POST['naulon_credits_token'] ) ) : '';
			Naulon_Settings::update( array( 'credits_token' => trim( $token ) ) );
			Naulon_Admin::notice( 'success', __( 'Saved.', 'naulon' ) );
			return;
		}

		$allow  = self::parse_fragments( isset( $_POST['naulon_seo_allowlist'] ) ? wp_unslash( $_POST['naulon_seo_allowlist'] ) : '' );
		$charge = self::parse_fragments( isset( $_POST['naulon_charge_list'] ) ? wp_unslash( $_POST['naulon_charge_list'] ) : '' );
		// phpcs:enable WordPress.Security.NonceVerification.Missing

		Naulon_Settings::update(
			array(
				'seo_allowlist' => $allow,
				'charge_list'   => $charge,
			)
		);
		Naulon_Admin::notice( 'success', __( 'Saved.', 'naulon' ) );
	}

	/**
	 * A textarea into a clean fragment list: trimmed, lower-cased, de-duplicated, no blanks.
	 *
	 * Lower-casing matters — the classifier compares against a lower-cased user agent, so a
	 * fragment with a capital letter would silently never match.
	 *
	 * @param string $raw Raw textarea value.
	 * @return string[]
	 */
	public static function parse_fragments( $raw ) {
		$lines = preg_split( '/[\r\n]+/', (string) $raw );
		$out   = array();
		foreach ( (array) $lines as $line ) {
			$fragment = strtolower( trim( sanitize_text_field( $line ) ) );
			if ( '' === $fragment ) {
				continue;
			}
			$out[ $fragment ] = true;
		}
		return array_keys( $out );
	}

	/* --------------------------------------------------------------------------------------- */
	/* The per-post box                                                                         */
	/* --------------------------------------------------------------------------------------- */

	/**
	 * Register the editor box on every tollable post type.
	 *
	 * @return void
	 */
	public static function add_meta_box() {
		if ( ! current_user_can( Naulon_Roles::TOLL_POSTS ) ) {
			return;
		}
		foreach ( Naulon_Credits::instance()->tollable_post_types() as $type ) {
			add_meta_box(
				'naulon-toll',
				__( 'naulon', 'naulon' ),
				array( __CLASS__, 'render_meta_box' ),
				$type,
				'side',
				'default'
			);
		}
	}

	/**
	 * @param WP_Post $post The post.
	 * @return void
	 */
	public static function render_meta_box( $post ) {
		wp_nonce_field( 'naulon_post_toll', 'naulon_post_toll_nonce' );
		$free = 'free' === get_post_meta( $post->ID, Naulon_Credits::POST_TOLL_META, true );

		printf(
			'<p><label><input type="checkbox" name="naulon_post_free" value="1" %s /> %s</label></p>',
			checked( $free, true, false ),
			esc_html__( 'Let everyone read this one free', 'naulon' )
		);

		$contributors = Naulon_Credits::instance()->contributors_for( $post );
		if ( empty( $contributors ) ) {
			echo '<p class="naulon-muted">' . esc_html__( 'This post reads free anyway: nobody credited on it has a wallet.', 'naulon' ) . '</p>';
			return;
		}
		echo '<p class="naulon-muted">' . esc_html__( 'Paid to:', 'naulon' ) . '</p><ul class="naulon-payees">';
		foreach ( $contributors as $contributor ) {
			printf( '<li><code>%s</code></li>', esc_html( (string) $contributor['wallet'] ) );
		}
		echo '</ul>';
	}

	/**
	 * Save the box. Capability AND nonce, and never on an autosave.
	 *
	 * @param int $post_id The post.
	 * @return void
	 */
	public static function save_meta_box( $post_id ) {
		if ( defined( 'DOING_AUTOSAVE' ) && DOING_AUTOSAVE ) {
			return;
		}
		if ( ! isset( $_POST['naulon_post_toll_nonce'] ) ) {
			return;
		}
		if ( ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['naulon_post_toll_nonce'] ) ), 'naulon_post_toll' ) ) {
			return;
		}
		if ( ! current_user_can( Naulon_Roles::TOLL_POSTS ) || ! current_user_can( 'edit_post', $post_id ) ) {
			return;
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- verified above.
		if ( isset( $_POST['naulon_post_free'] ) ) {
			update_post_meta( $post_id, Naulon_Credits::POST_TOLL_META, 'free' );
		} else {
			delete_post_meta( $post_id, Naulon_Credits::POST_TOLL_META );
		}
	}
}
