<?php
/**
 * Parity harness: reads JSON cases from stdin, one per line ({"rules":…, "ua":…}), and prints the
 * plugin's access decision for each. The control plane's `wp-rules-parity.test.ts` runs the gate's
 * `decide()` over the same cases and requires the same answers. Test-only; not shipped.
 *
 * @package naulon
 */

require __DIR__ . '/bootstrap.php';

while ( ( $line = fgets( STDIN ) ) !== false ) {
	$case  = json_decode( $line, true );
	$rules = null === $case['rules'] ? null : Naulon_Rules::normalize( $case['rules'] );
	$a     = Naulon_Rules::access(
		array(
			'user_agent'         => $case['ua'],
			'accept'             => '*/*',
			'has_payment_header' => false,
			'declared_agent_id'  => '',
			'headers'            => array(),
		),
		$rules,
		array()
	);
	echo $a['action'], "\n";
}
