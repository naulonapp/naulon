<?php
/**
 * Wallet validation. Wallets are where money lands, so every check here fails CLOSED: an
 * address we are not certain about is not a payee, and a post whose contributors have no
 * usable wallet reads free rather than paying someone arbitrary.
 *
 * The zero address is refused at SAVE time, not only at emit. An address that only fails when
 * money is already moving is a trap; the author who typed it deserves to hear about it while
 * they are still looking at the field.
 *
 * Pure functions, no WordPress calls.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Wallet {

	/** The EVM burn address. Never a payee — funds sent there are destroyed. */
	const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

	/**
	 * Is this a well-formed, payable EVM address?
	 *
	 * @param mixed $address Candidate.
	 * @return bool
	 */
	public static function is_valid( $address ) {
		if ( ! is_string( $address ) ) {
			return false;
		}
		$value = trim( $address );
		if ( 1 !== preg_match( '/^0x[0-9a-fA-F]{40}$/', $value ) ) {
			return false;
		}
		return ! self::is_zero( $value );
	}

	/**
	 * The burn address, case-insensitively.
	 *
	 * @param string $address Candidate.
	 * @return bool
	 */
	public static function is_zero( $address ) {
		return is_string( $address ) && 0 === strcasecmp( trim( $address ), self::ZERO_ADDRESS );
	}

	/**
	 * Normalize for storage: trimmed, lower-cased. We deliberately do NOT re-checksum
	 * (EIP-55) — a mixed-case address the author pasted from their wallet is already
	 * checksummed, and silently rewriting the case they see is worse than storing the
	 * canonical lower-case form everything downstream compares against.
	 *
	 * @param string $address Valid address.
	 * @return string
	 */
	public static function normalize( $address ) {
		return strtolower( trim( (string) $address ) );
	}

	/**
	 * Why an address was refused — the message an author actually sees. Returns null when the
	 * address is fine.
	 *
	 * @param mixed $address Candidate.
	 * @return string|null
	 */
	public static function rejection_reason( $address ) {
		if ( ! is_string( $address ) || '' === trim( $address ) ) {
			return __( 'Enter a wallet address, or leave this empty — your posts will simply read free.', 'naulon' );
		}
		$value = trim( $address );
		if ( 0 !== strpos( $value, '0x' ) ) {
			return __( 'A wallet address starts with 0x.', 'naulon' );
		}
		if ( 42 !== strlen( $value ) ) {
			return __( 'A wallet address is 42 characters: 0x followed by 40 hex digits.', 'naulon' );
		}
		if ( 1 !== preg_match( '/^0x[0-9a-fA-F]{40}$/', $value ) ) {
			return __( 'That address contains characters that are not hex digits.', 'naulon' );
		}
		if ( self::is_zero( $value ) ) {
			return __( 'That is the burn address — anything sent there is destroyed. Use the wallet you actually control.', 'naulon' );
		}
		return null;
	}
}
