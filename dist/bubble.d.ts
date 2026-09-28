/** The origins a bubble may ride from: the estate pattern (the same rule
 *  corsHeaders applies) plus localhost for the local dev posture. */
export declare function isAllowedBubbleOrigin(origin: string): boolean;
/** The confirm page the callback renders in bubble mode. Static inline
 *  HTML+JS, everything escaped, targetOrigin = the validated origin
 *  (never "*"). The token leaves ONLY on the user's explicit Continue —
 *  a popup the user never asked for (a page opening it under the OP's
 *  SSO session) shows the request and stops here. */
export declare function bubbleConfirmPage(opts: {
    name: string;
    origin: string;
    token: string;
    expiresAt: number;
}): string;
