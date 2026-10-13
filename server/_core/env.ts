export const ENV = {
  dexcomClientId: process.env.DEXCOM_CLIENT_ID ?? "",
  dexcomClientSecret: process.env.DEXCOM_CLIENT_SECRET ?? "",
  // Dexcom Share (live data): the CGM wearer's own Dexcom login. Read on each
  // access rather than at import, so tests can blank them out reliably — no
  // test should ever be able to reach the real Share service.
  get dexcomShareUsername() {
    return process.env.DEXCOM_SHARE_USERNAME ?? "";
  },
  get dexcomSharePassword() {
    return process.env.DEXCOM_SHARE_PASSWORD ?? "";
  },
};
