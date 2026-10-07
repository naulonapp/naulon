<?php
/**
 * The credits contract — `GET /wp-json/naulon/v1/credits/<slug>` — served from real WordPress
 * author data.
 *
 * This is a money-routing boundary: whatever this returns decides which wallet gets paid. Two
 * rules follow from that, and they are the whole design.
 *
 * 1. **404 means free, and it is a feature.** A missing, draft, private, password-protected or
 *    wallet-less post answers 404, which the gate reads as the deliberate don't-gate signal.
 *    Failing closed here means failing to FREE, never failing to "pay someone plausible".
 *
 * 2. **Ambiguity is never resolved by guessing.** A bare slug that matches more than one post
 *    answers 404. Production once paid the wrong wallet because a full-path slug missed a
 *    bare-slug lookup and fell through to a pinned wallet; a guess in this function is the same
 *    bug wearing a different hat.
 *
 * The emitted object is validated upstream by a STRICT schema — unknown keys are rejected
 * outright — so this must emit exactly {slug, title, contributors[]} and nothing more. No
 * excerpt, no dates, no "helpful" extras.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Credits {

	const NAMESPACE_V1 = 'naulon/v1';

	/** Author wallet, per user. */
	const USER_WALLET_META = 'naulon_wallet';

	/** Per-post override: 'free' forces a free read regardless of wallets. */
	const POST_TOLL_META = '_naulon_tollable';

	/** @var Naulon_Credits|null */
	private static $instance = null;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	public function register() {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	/**
	 * The address a publisher hands to the control plane — the **base**, with no trailing slash
	 * and no `/credits` segment.
	 *
	 * This distinction is worth a method of its own because getting it wrong is silent. The
	 * consumer appends `/credits/<slug>` itself (`httpResolver` in the SDK), so handing it the
	 * full route address makes it fetch `…/credits/credits/<slug>`. That happens to resolve here
	 * today — only because the route accepts a bare slug as a fallback and finds the leaf — but
	 * it stops resolving the moment a site uses a path-style permalink or has two posts sharing
	 * a leaf, and the failure is a 404, which means "read this one free". Silently, forever.
	 *
	 * @return string e.g. https://example.com/wp-json/naulon/v1
	 */
	public static function credits_base_url() {
		return untrailingslashit( rest_url( self::NAMESPACE_V1 ) );
	}

	public function register_routes() {
		register_rest_route(
			self::NAMESPACE_V1,
			'/credits/(?P<slug>.+)',
			array(
				'methods'  => 'GET',
				'callback' => array( $this, 'handle' ),
				// Public by design: the gate calls this unauthenticated from another host. The
				// optional shared token below is the tightening for publishers who want it; the
				// content leak risk is handled by never describing an unpublished post at all.
				'permission_callback' => '__return_true',
				'args'                => array(
					'slug' => array(
						'required' => true,
						'type'     => 'string',
					),
				),
			)
		);

		register_rest_route(
			self::NAMESPACE_V1,
			'/catalog',
			array(
				'methods'             => 'GET',
				'callback'            => array( $this, 'catalog' ),
				// Public, as the naulon catalog contract asks. It lists only what `is_tollable` lets
				// the credits endpoint describe (published, no password, not opted out), which the
				// site's own sitemap and feed already publish, and it never carries a wallet. The
				// optional credits token guards wallets and unpublished slugs, neither of which is here.
				'permission_callback' => '__return_true',
			)
		);
	}

	/** Posts per catalog page. */
	const CATALOG_PAGE = 100;

	/**
	 * The naulon catalog contract: every post the credits endpoint would charge for, with its exact
	 * slug and every author under the id that endpoint pays. `{ entries, nextCursor }`, paged with
	 * `?cursor=`. The teaser is the post's own excerpt only, never text taken from the body.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response
	 */
	public function catalog( $request ) {
		$page  = self::page_from_cursor( (string) $request->get_param( 'cursor' ) );
		$query = new WP_Query(
			array(
				'post_type'           => $this->tollable_post_types(),
				'post_status'         => 'publish',
				'has_password'        => false,
				'posts_per_page'      => self::CATALOG_PAGE,
				'paged'               => $page,
				'orderby'             => 'ID',
				'order'               => 'ASC',
				'ignore_sticky_posts' => true,
			)
		);

		$entries = array();
		foreach ( $query->posts as $post ) {
			if ( ! $this->is_tollable( $post ) ) {
				continue;
			}
			$authors = $this->catalog_authors( $post );
			if ( empty( $authors ) ) {
				continue; // the credits endpoint answers 404 for it, so listing it would sell nothing.
			}
			$entry   = array(
				'slug'        => Naulon_Slug::canonicalize( $this->canonical_slug_for( $post ) ),
				'title'       => wp_strip_all_tags( get_the_title( $post ) ),
				'url'         => get_permalink( $post ),
				'authors'     => $authors,
				'publishedAt' => get_post_time( 'c', true, $post ),
			);
			$excerpt = trim( wp_strip_all_tags( (string) $post->post_excerpt ) );
			if ( '' !== $excerpt ) {
				$entry['summary'] = function_exists( 'mb_substr' ) ? mb_substr( $excerpt, 0, 500 ) : substr( $excerpt, 0, 500 );
			}
			$entries[] = $entry;
		}

		$body = array( 'entries' => $entries );
		if ( $page < (int) $query->max_num_pages ) {
			$body['nextCursor'] = self::cursor_for_page( $page + 1 );
		}
		$response = new WP_REST_Response( $body, 200 );
		$response->header( 'Cache-Control', 'public, max-age=300' );
		return $response;
	}

	/**
	 * The authors a catalog entry names: the same ids, in the same order, as the credits endpoint
	 * pays for the post, each with a display name. Never a wallet.
	 *
	 * @param WP_Post $post The post.
	 * @return array[] Each {id, name}.
	 */
	private function catalog_authors( $post ) {
		$names = array();
		foreach ( Naulon_Authors::for_post( $post ) as $a ) {
			if ( isset( $a['name'] ) ) {
				$names[ Naulon_Authors::author_id( $a ) ] = $a['name'];
			}
		}
		$out = array();
		foreach ( $this->contributors_for( $post ) as $c ) {
			$id   = $c['authorId'];
			$name = isset( $names[ $id ] ) ? $names[ $id ] : '';
			if ( '' === $name && preg_match( '/^wp-user-(\d+)$/', $id, $m ) ) {
				$user = get_userdata( (int) $m[1] );
				$name = $user ? $user->display_name : '';
			}
			$out[] = array(
				'id'   => $id,
				'name' => '' !== $name ? $name : $id,
			);
		}
		return $out;
	}

	/**
	 * Page number from an opaque cursor; a missing or unreadable one is the first page.
	 *
	 * @param string $cursor The cursor.
	 * @return int
	 */
	public static function page_from_cursor( $cursor ) {
		$decoded = base64_decode( $cursor, true );
		return ( false !== $decoded && ctype_digit( $decoded ) && (int) $decoded > 0 ) ? (int) $decoded : 1;
	}

	/**
	 * The opaque cursor for a page number.
	 *
	 * @param int $page The page.
	 * @return string
	 */
	public static function cursor_for_page( $page ) {
		return base64_encode( (string) (int) $page );
	}

	/**
	 * Serve the contract.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response
	 */
	public function handle( $request ) {
		if ( ! $this->token_ok( $request ) ) {
			// A wrong token is answered exactly like a missing post. Distinguishing them would
			// let a caller enumerate which slugs exist.
			return $this->free_read();
		}

		$post = $this->resolve_post( (string) $request->get_param( 'slug' ) );
		if ( null === $post ) {
			return $this->free_read();
		}
		if ( ! $this->is_tollable( $post ) ) {
			return $this->free_read();
		}

		$contributors = $this->contributors_for( $post );
		if ( empty( $contributors ) ) {
			// Nobody to pay ⇒ free. Never fall back to "some wallet on the site".
			return $this->free_read();
		}

		return new WP_REST_Response(
			array(
				'slug'         => Naulon_Slug::canonicalize( $this->canonical_slug_for( $post ) ),
				'title'        => wp_strip_all_tags( get_the_title( $post ) ),
				'contributors' => $contributors,
			),
			200
		);
	}

	/**
	 * Resolve a post from either the canonical full path or the bare post slug — accepting both
	 * is what closes the full-path/bare-slug mismatch. A bare slug matching several posts is
	 * ambiguous and resolves to nothing.
	 *
	 * @param string $raw The requested slug.
	 * @return WP_Post|null
	 */
	public function resolve_post( $raw ) {
		$canonical = Naulon_Slug::canonicalize( $raw );
		if ( '' === $canonical ) {
			return null;
		}

		// Exact path first: this is the unambiguous form and the one the gate derives.
		$by_path = get_page_by_path( $canonical, OBJECT, $this->tollable_post_types() );
		if ( $by_path instanceof WP_Post ) {
			return $by_path;
		}

		$leaf = Naulon_Slug::leaf( $canonical );
		if ( '' === $leaf ) {
			return null;
		}

		$matches = get_posts(
			array(
				'name'             => $leaf,
				'post_type'        => $this->tollable_post_types(),
				'post_status'      => 'publish',
				'numberposts'      => 2, // 2 is enough to detect ambiguity; no need to load more.
				'suppress_filters' => false,
			)
		);

		if ( 1 !== count( $matches ) ) {
			// 0 = unknown, 2+ = ambiguous. Both are free reads: paying on a guess is the bug.
			return null;
		}
		return $matches[0];
	}

	/**
	 * Should this post be tolled at all? Every "no" here is a deliberate don't-gate signal.
	 *
	 * @param WP_Post $post The post.
	 * @return bool
	 */
	public function is_tollable( $post ) {
		if ( 'publish' !== $post->post_status ) {
			return false; // drafts, pending, private, trashed — never described to a caller.
		}
		if ( '' !== $post->post_password ) {
			return false; // already gated by a password; a second toll is a double charge.
		}
		if ( 'free' === get_post_meta( $post->ID, self::POST_TOLL_META, true ) ) {
			return false; // explicit editorial opt-out.
		}
		/**
		 * Filter whether a post is tollable. This is the seam membership plugins hook: a post
		 * that is already behind a paid membership must not be tolled a second time.
		 *
		 * @param bool    $tollable Current verdict.
		 * @param WP_Post $post     The post.
		 */
		return (bool) apply_filters( 'naulon_is_tollable', true, $post );
	}

	/**
	 * The contributors, in the strict upstream shape. Without a usable wallet here a contributor is
	 * emitted WITHOUT one — a delegated payee — never substituted with somebody else's address. A
	 * platform holding that author's own wallet can then route their share; where nothing does, the
	 * leg is dropped downstream and the post reads free.
	 *
	 * @param WP_Post $post The post.
	 * @return array[] Zero or more {authorId, weight?, wallet}.
	 */
	public function contributors_for( $post ) {
		// Every byline a multi-author plugin records, each an equal share; else the post's one author.
		$raw = array();
		foreach ( Naulon_Authors::for_post( $post ) as $author ) {
			$author['weight'] = 1.0;
			$raw[]            = $author;
		}
		if ( empty( $raw ) ) {
			$raw = array(
				array(
					'user_id' => (int) $post->post_author,
					'weight'  => 1.0,
				),
			);
		}

		/**
		 * Filter the contributor list before wallets are resolved. Each entry is
		 * {user_id, weight} for a WordPress user, or {guest_id, weight} for a Co-Authors Plus
		 * guest author with no linked account.
		 *
		 * @param array[] $raw  Each {user_id:int, weight:float}.
		 * @param WP_Post $post The post.
		 */
		$raw = apply_filters( 'naulon_post_contributors', $raw, $post );

		$out = array();
		foreach ( $raw as $entry ) {
			$weight = isset( $entry['weight'] ) ? (float) $entry['weight'] : 1.0;
			// A guest author has no WordPress account, so no profile wallet: it is named without one
			// (delegated), and the site's own choice for unclaimed shares decides where that share goes.
			if ( isset( $entry['guest_id'] ) && ! isset( $entry['user_id'] ) ) {
				if ( $weight > 0 ) {
					$guest = array( 'authorId' => Naulon_Authors::author_id( $entry ) );
					if ( 1.0 !== $weight ) {
						$guest['weight'] = $weight;
					}
					$out[] = $guest;
				}
				continue;
			}
			if ( ! isset( $entry['user_id'] ) ) {
				continue;
			}
			$user_id = (int) $entry['user_id'];
			// A non-positive weight means "takes nothing", and the only truthful way to say that
			// in this contract is to omit the contributor: the upstream schema is
			// `weight: z.number().positive()`, so a literal 0 would be REJECTED and take the whole
			// document — every contributor on the article — down with it. Omitting the key instead
			// was worse still: upstream reads a missing weight as 1, so a contributor a filter had
			// explicitly zeroed was paid a FULL share. (`(float)` also maps a non-numeric weight to
			// 0.0, which lands here rather than silently becoming 1.) Their weight redistributes
			// among the rest, exactly as an unpayable leaf's does.
			if ( ! ( $weight > 0 ) ) {
				continue;
			}
			$wallet      = get_user_meta( $user_id, self::USER_WALLET_META, true );
			$contributor = array( 'authorId' => Naulon_Authors::author_id( array( 'user_id' => $user_id ) ) );
			// No wallet here ⇒ named without one (delegated). Dropping them was indistinguishable
			// from a solo-authored post, so an author who set a wallet on the platform and none here
			// was never paid and never told.
			if ( Naulon_Wallet::is_valid( $wallet ) ) {
				$contributor['wallet'] = Naulon_Wallet::normalize( $wallet );
			}
			if ( 1.0 !== $weight ) {
				$contributor['weight'] = $weight;
			}
			$out[] = $contributor;
		}

		return $out;
	}

	/**
	 * The contributors this site can actually PAY, right here, with no platform in front of it.
	 *
	 * `contributors_for` emits delegated payees — named, wallet-less — because the credits document
	 * is read by a control plane that may hold that author's own wallet and fill the leg. Nothing
	 * fills it inside WordPress, so every decision about whether to TOLL must ask this instead:
	 * a wallet-less contributor is somebody we cannot pay, and charging an agent when there is
	 * nobody to pay is the failure the credits contract exists to prevent.
	 *
	 * Mirrors `resolvePayees` upstream, which filters unpayable leaves before pricing and returns
	 * an empty set — no quote, a free read — when none remain.
	 *
	 * @param WP_Post $post The post.
	 * @return array[] Zero or more {authorId, weight?, wallet} — every entry carrying a wallet.
	 */
	public function payable_contributors_for( $post ) {
		$payable = array();
		foreach ( $this->contributors_for( $post ) as $contributor ) {
			if ( isset( $contributor['wallet'] ) && '' !== $contributor['wallet'] ) {
				$payable[] = $contributor;
			}
		}
		return $payable;
	}

	/**
	 * The canonical slug for a post: its permalink path, leading slash stripped — the same
	 * derivation the gate performs, so both sides agree without anyone hand-entering prefixes.
	 *
	 * @param WP_Post $post The post.
	 * @return string
	 */
	public function canonical_slug_for( $post ) {
		return Naulon_Slug::canonicalize( get_permalink( $post ) );
	}

	/**
	 * Which post types can be tolled. Pages are excluded by default — an About page is not the
	 * article an agent is citing.
	 *
	 * @return string[]
	 */
	public function tollable_post_types() {
		/**
		 * Filter the tollable post types.
		 *
		 * @param string[] $types Post types.
		 */
		return (array) apply_filters( 'naulon_tollable_post_types', array( 'post' ) );
	}

	/**
	 * Optional shared-token gate. Empty setting = open endpoint (the default: the gate calls
	 * from another host and the response describes only published work).
	 *
	 * @param WP_REST_Request $request The request.
	 * @return bool
	 */
	private function token_ok( $request ) {
		$settings = Naulon_Settings::all();
		$expected = is_string( $settings['credits_token'] ) ? trim( $settings['credits_token'] ) : '';
		if ( '' === $expected ) {
			return true;
		}
		$header = (string) $request->get_header( 'authorization' );
		if ( 0 !== stripos( $header, 'bearer ' ) ) {
			return false;
		}
		return hash_equals( $expected, trim( substr( $header, 7 ) ) );
	}

	/**
	 * The don't-gate signal.
	 *
	 * @return WP_REST_Response
	 */
	private function free_read() {
		return new WP_REST_Response( array( 'code' => 'naulon_free_read' ), 404 );
	}
}
