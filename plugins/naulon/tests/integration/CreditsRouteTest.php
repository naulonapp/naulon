<?php
/**
 * The credits contract against real WordPress posts, users and meta.
 *
 * Every assertion here is "would this have paid the right person, or paid nobody". A 404 is the
 * deliberate don't-gate signal, so the tests that expect 404 are not testing an error path —
 * they are testing that the article reads free.
 *
 * @package naulon
 */

class CreditsRouteTest extends WP_UnitTestCase {

	const WALLET_A = '0x1111111111111111111111111111111111111111';
	const WALLET_B = '0x2222222222222222222222222222222222222222';

	/** @var int */
	private $paid_author;

	/** @var int */
	private $walletless_author;

	public function set_up() {
		parent::set_up();

		$this->paid_author = self::factory()->user->create( array( 'role' => 'author' ) );
		update_user_meta( $this->paid_author, Naulon_Credits::USER_WALLET_META, self::WALLET_A );

		$this->walletless_author = self::factory()->user->create( array( 'role' => 'author' ) );

		// A prefixed permalink structure is the shape that produced the production incident:
		// the gate derives `blog/<name>` while a naive endpoint only answers `<name>`.
		update_option( 'permalink_structure', '/blog/%postname%/' );
		// The REST route is registered on rest_api_init; the test server needs it explicitly.
		do_action( 'rest_api_init' );
	}

	public function tear_down() {
		update_option( 'permalink_structure', '' );
		parent::tear_down();
	}

	private function get_credits( $slug ) {
		$request  = new WP_REST_Request( 'GET', '/naulon/v1/credits/' . $slug );
		$request->set_url_params( array( 'slug' => $slug ) );
		$response = rest_get_server()->dispatch( $request );
		return $response;
	}

	private function publish( $author, $name ) {
		return self::factory()->post->create(
			array(
				'post_author' => $author,
				'post_name'   => $name,
				'post_title'  => 'Title of ' . $name,
				'post_status' => 'publish',
			)
		);
	}

	public function test_a_published_post_with_a_wallet_returns_the_strict_contract_shape() {
		$this->publish( $this->paid_author, 'tolled-post' );

		$response = $this->get_credits( 'blog/tolled-post' );
		$this->assertSame( 200, $response->get_status() );

		$data = $response->get_data();
		// The upstream schema is strict — an extra key is a hard rejection there, so the set of
		// keys is part of the contract, not an implementation detail.
		$this->assertSame( array( 'slug', 'title', 'contributors' ), array_keys( $data ) );
		$this->assertSame( 'blog/tolled-post', $data['slug'] );
		$this->assertSame( 'Title of tolled-post', $data['title'] );
		$this->assertCount( 1, $data['contributors'] );
		$this->assertSame( 'wp-user-' . $this->paid_author, $data['contributors'][0]['authorId'] );
		$this->assertSame( self::WALLET_A, $data['contributors'][0]['wallet'] );
		$this->assertArrayNotHasKey( 'weight', $data['contributors'][0] );
	}

	public function test_the_bare_slug_resolves_to_the_same_post_and_returns_the_canonical_path() {
		$this->publish( $this->paid_author, 'tolled-post' );

		$response = $this->get_credits( 'tolled-post' );
		$this->assertSame( 200, $response->get_status() );
		// The canonical full path comes back even though a bare slug was asked for. This is the
		// production incident closed: both forms resolve, and the answer names one of them.
		$this->assertSame( 'blog/tolled-post', $response->get_data()['slug'] );
	}

	/**
	 * Named, with no wallet — a delegated payee. A gate that cannot fill the leg drops it and the
	 * post reads free, the old 404's outcome. What the named leg buys is a platform routing that
	 * author's share to a wallet they registered there.
	 */
	public function test_a_post_whose_author_has_no_wallet_names_them_without_one() {
		$this->publish( $this->walletless_author, 'no-wallet-post' );
		$response = $this->get_credits( 'blog/no-wallet-post' );
		$this->assertSame( 200, $response->get_status() );
		$data = $response->get_data();
		$this->assertCount( 1, $data['contributors'] );
		$this->assertSame( 'wp-user-' . $this->walletless_author, $data['contributors'][0]['authorId'] );
		$this->assertArrayNotHasKey( 'wallet', $data['contributors'][0] );
	}

	/**
	 * An unusable address is not a destination, so the contributor is emitted delegated — never
	 * substituted with somebody else's.
	 */
	public function test_an_invalid_or_zero_wallet_is_never_emitted_as_a_payee() {
		$author = self::factory()->user->create( array( 'role' => 'author' ) );
		update_user_meta( $author, Naulon_Credits::USER_WALLET_META, '0x0000000000000000000000000000000000000000' );
		$this->publish( $author, 'burn-wallet-post' );
		$data = $this->get_credits( 'blog/burn-wallet-post' )->get_data();
		$this->assertArrayNotHasKey( 'wallet', $data['contributors'][0] );

		update_user_meta( $author, Naulon_Credits::USER_WALLET_META, 'not-an-address' );
		$data = $this->get_credits( 'blog/burn-wallet-post' )->get_data();
		$this->assertArrayNotHasKey( 'wallet', $data['contributors'][0] );
	}

	public function test_unpublished_work_is_never_described() {
		$draft = self::factory()->post->create(
			array(
				'post_author' => $this->paid_author,
				'post_name'   => 'draft-post',
				'post_status' => 'draft',
			)
		);
		$this->assertSame( 404, $this->get_credits( 'blog/draft-post' )->get_status() );

		wp_update_post( array( 'ID' => $draft, 'post_status' => 'private' ) );
		$this->assertSame( 404, $this->get_credits( 'blog/draft-post' )->get_status() );
	}

	public function test_a_password_protected_post_is_not_double_tolled() {
		$post = $this->publish( $this->paid_author, 'pw-post' );
		wp_update_post( array( 'ID' => $post, 'post_password' => 'secret' ) );
		$this->assertSame( 404, $this->get_credits( 'blog/pw-post' )->get_status() );
	}

	public function test_an_editorial_opt_out_reads_free() {
		$post = $this->publish( $this->paid_author, 'opted-out' );
		update_post_meta( $post, Naulon_Credits::POST_TOLL_META, 'free' );
		$this->assertSame( 404, $this->get_credits( 'blog/opted-out' )->get_status() );
	}

	public function test_the_membership_filter_can_refuse_to_double_toll() {
		$post = $this->publish( $this->paid_author, 'members-only' );
		add_filter( 'naulon_is_tollable', '__return_false' );
		$this->assertSame( 404, $this->get_credits( 'blog/members-only' )->get_status() );
		remove_filter( 'naulon_is_tollable', '__return_false' );
		$this->assertSame( 200, $this->get_credits( 'blog/members-only' )->get_status() );
	}

	public function test_an_unknown_slug_reads_free() {
		$this->assertSame( 404, $this->get_credits( 'blog/does-not-exist' )->get_status() );
		$this->assertSame( 404, $this->get_credits( 'nonsense' )->get_status() );
	}

	public function test_co_authors_carry_relative_weights_and_walletless_ones_are_delegated() {
		$post   = $this->publish( $this->paid_author, 'co-authored' );
		$second = self::factory()->user->create( array( 'role' => 'author' ) );
		update_user_meta( $second, Naulon_Credits::USER_WALLET_META, self::WALLET_B );

		$walletless = $this->walletless_author;
		$primary    = $this->paid_author;

		add_filter(
			'naulon_post_contributors',
			function () use ( $primary, $second, $walletless ) {
				return array(
					array( 'user_id' => $primary, 'weight' => 0.6 ),
					array( 'user_id' => $second, 'weight' => 0.4 ),
					// No wallet: named without one, never substituted with someone else's address.
					array( 'user_id' => $walletless, 'weight' => 0.9 ),
				);
			}
		);

		$data = $this->get_credits( 'blog/co-authored' )->get_data();
		remove_all_filters( 'naulon_post_contributors' );

		$this->assertCount( 3, $data['contributors'] );
		$this->assertSame( 0.6, $data['contributors'][0]['weight'] );
		$this->assertSame( self::WALLET_B, $data['contributors'][1]['wallet'] );
		// Named, weighted, no destination. Downstream fills it or drops it; dropping redistributes
		// the weight (asserted in @naulon/shared's attribution tests).
		$this->assertSame( 'wp-user-' . $walletless, $data['contributors'][2]['authorId'] );
		$this->assertArrayNotHasKey( 'wallet', $data['contributors'][2] );
		$this->assertSame( 0.9, $data['contributors'][2]['weight'] );
	}

	public function test_a_zero_weight_contributor_is_omitted_rather_than_paid_a_full_share() {
		// The upstream schema is `weight: z.number().positive()`, so a literal 0 would be rejected
		// and take the whole document down with it — every contributor on the article. Omitting
		// just the KEY was worse: a missing weight reads as 1 upstream, so a contributor a filter
		// had explicitly zeroed was paid the LARGEST share on the article.
		$post   = $this->publish( $this->paid_author, 'zero-weighted' );
		$second = self::factory()->user->create( array( 'role' => 'author' ) );
		update_user_meta( $second, Naulon_Credits::USER_WALLET_META, self::WALLET_B );

		$primary = $this->paid_author;
		add_filter(
			'naulon_post_contributors',
			function () use ( $primary, $second ) {
				return array(
					array( 'user_id' => $primary, 'weight' => 1.0 ),
					array( 'user_id' => $second, 'weight' => 0 ),
				);
			}
		);

		$data = $this->get_credits( 'blog/zero-weighted' )->get_data();
		remove_all_filters( 'naulon_post_contributors' );

		$this->assertCount( 1, $data['contributors'], 'a contributor who takes nothing is not a payee' );
		$this->assertSame( 'wp-user-' . $primary, $data['contributors'][0]['authorId'] );
	}

	public function test_an_unreadable_weight_is_treated_as_zero_not_as_one() {
		$post = $this->publish( $this->paid_author, 'junk-weighted' );

		$primary = $this->paid_author;
		add_filter(
			'naulon_post_contributors',
			function () use ( $primary ) {
				return array( array( 'user_id' => $primary, 'weight' => 'a lot' ) );
			}
		);

		$response = $this->get_credits( 'blog/junk-weighted' );
		remove_all_filters( 'naulon_post_contributors' );

		// Nobody left to credit ⇒ the free-read signal, never a full share invented from a cast.
		$this->assertSame( 404, $response->get_status() );
	}

	public function test_a_shared_token_gates_the_endpoint_without_revealing_which_slugs_exist() {
		$this->publish( $this->paid_author, 'tolled-post' );
		Naulon_Settings::update( array( 'credits_token' => 'shhh' ) );

		// Wrong/missing token answers exactly like a missing post — no enumeration oracle.
		$this->assertSame( 404, $this->get_credits( 'blog/tolled-post' )->get_status() );

		$request = new WP_REST_Request( 'GET', '/naulon/v1/credits/blog/tolled-post' );
		$request->set_url_params( array( 'slug' => 'blog/tolled-post' ) );
		$request->set_header( 'authorization', 'Bearer shhh' );
		$this->assertSame( 200, rest_get_server()->dispatch( $request )->get_status() );

		Naulon_Settings::update( array( 'credits_token' => '' ) );
	}
}
