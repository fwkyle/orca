const {
  LOCAL_MAC_SIGNING_IDENTITY,
  createLocalMacCodesignArgs,
  requireIdentityHash
} = require('./macos-local-signing.cjs')

function getMacSigningIdentity({ isMacRelease, isMacLocal, localMacSigning }) {
  if (isMacRelease) {
    return undefined
  }
  if (isMacLocal) {
    return requireIdentityHash(localMacSigning?.identityHash)
  }
  return LOCAL_MAC_SIGNING_IDENTITY
}

function localComputerUseCodesignArgs(identityHash, targetPath, keychainPath) {
  return createLocalMacCodesignArgs(identityHash, targetPath, keychainPath, { deep: true })
}

function localNotificationStatusCodesignArgs(identityHash, targetPath, keychainPath) {
  return createLocalMacCodesignArgs(identityHash, targetPath, keychainPath)
}

module.exports = {
  getMacSigningIdentity,
  localComputerUseCodesignArgs,
  localNotificationStatusCodesignArgs
}
