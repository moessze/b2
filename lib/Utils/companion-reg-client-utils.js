export var CompanionWebClientType;
(function (CompanionWebClientType) {
    CompanionWebClientType[CompanionWebClientType["UNKNOWN"] = 0] = "UNKNOWN";
    CompanionWebClientType[CompanionWebClientType["CHROME"] = 1] = "CHROME";
    CompanionWebClientType[CompanionWebClientType["EDGE"] = 2] = "EDGE";
    CompanionWebClientType[CompanionWebClientType["FIREFOX"] = 3] = "FIREFOX";
    CompanionWebClientType[CompanionWebClientType["IE"] = 4] = "IE";
    CompanionWebClientType[CompanionWebClientType["OPERA"] = 5] = "OPERA";
    CompanionWebClientType[CompanionWebClientType["SAFARI"] = 6] = "SAFARI";
    CompanionWebClientType[CompanionWebClientType["ELECTRON"] = 7] = "ELECTRON";
    CompanionWebClientType[CompanionWebClientType["UWP"] = 8] = "UWP";
    CompanionWebClientType[CompanionWebClientType["OTHER_WEB_CLIENT"] = 9] = "OTHER_WEB_CLIENT";
})(CompanionWebClientType || (CompanionWebClientType = {}));
const BROWSER_TO_COMPANION_WEB_CLIENT = {
    Chrome: CompanionWebClientType.CHROME,
    Edge: CompanionWebClientType.EDGE,
    Firefox: CompanionWebClientType.FIREFOX,
    IE: CompanionWebClientType.IE,
    Opera: CompanionWebClientType.OPERA,
    Safari: CompanionWebClientType.SAFARI
};
export const getCompanionWebClientType = ([os, browserName]) => {
    if (browserName === 'Desktop') {
        return os === 'Windows' ? CompanionWebClientType.UWP : CompanionWebClientType.ELECTRON;
    }
    return BROWSER_TO_COMPANION_WEB_CLIENT[browserName] || CompanionWebClientType.OTHER_WEB_CLIENT;
};
export const getCompanionPlatformId = (browser) => {
    return getCompanionWebClientType(browser).toString();
};
const DEFAULT_PAIRING_CODE_BROWSER_PLATFORM = { id: '1', displayName: 'Chrome' };
/**
 * The pairing-code flow uses its own platform numbering, which is NOT the same as
 * CompanionWebClientType (there Edge=2, Firefox=3, IE=4, Opera=5, Safari=6).
 * Sending the web-client value here makes WhatsApp ignore the registration.
 */
const PAIRING_CODE_BROWSER_PLATFORM = {
    Chrome: DEFAULT_PAIRING_CODE_BROWSER_PLATFORM,
    Firefox: { id: '2', displayName: 'Firefox' },
    IE: { id: '3', displayName: 'IE' },
    Opera: { id: '4', displayName: 'Opera' },
    Safari: { id: '5', displayName: 'Safari' },
    Edge: { id: '6', displayName: 'Edge' }
};
/** WhatsApp only accepts these OS labels in companion_platform_display. */
const PAIRING_CODE_OS_DISPLAY = new Set(['Mac OS', 'Windows', 'Ubuntu']);
/**
 * Normalizes an arbitrary `browser` description into a browser/OS pair WhatsApp accepts for
 * pairing-code registration. A custom label (e.g. Browsers.baileys('MyBot') -> 'MyBot (Baileys)')
 * is silently rejected by the server: the code is displayed but the device never links.
 */
export const getPairingCodePlatform = ([os, browserName]) => {
    const browser = PAIRING_CODE_BROWSER_PLATFORM[browserName] || DEFAULT_PAIRING_CODE_BROWSER_PLATFORM;
    const osDisplay = PAIRING_CODE_OS_DISPLAY.has(os) ? os : 'Mac OS';
    return {
        id: browser.id,
        display: `${browser.displayName} (${osDisplay})`
    };
};
export const buildPairingQRData = (ref, noiseKeyB64, identityKeyB64, advB64, browser) => {
    return 'https://wa.me/settings/linked_devices#' + [
        ref,
        noiseKeyB64,
        identityKeyB64,
        advB64,
        getCompanionPlatformId(browser)
    ].join(',');
};
//# sourceMappingURL=companion-reg-client-utils.js.map