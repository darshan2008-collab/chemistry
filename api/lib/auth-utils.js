function createAuthUtils({ authPepper, passwordHashRounds, crypto, bcrypt }) {
  function hashPasswordLegacy(value) {
    return crypto.createHash('sha256').update(`${String(value)}:${authPepper}`).digest('hex');
  }

  function isBcryptHash(hashValue) {
    return /^\$2[aby]\$\d{2}\$/.test(String(hashValue || ''));
  }

  function hashPassword(value) {
    return bcrypt.hashSync(`${String(value)}:${authPepper}`, passwordHashRounds);
  }

  function verifyPassword(value, passwordHash) {
    const input = `${String(value)}:${authPepper}`;
    if (isBcryptHash(passwordHash)) {
      return bcrypt.compareSync(input, String(passwordHash || ''));
    }
    return hashPasswordLegacy(value) === String(passwordHash || '');
  }

  function createSessionToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  return {
    hashPassword,
    verifyPassword,
    createSessionToken,
    isBcryptHash,
  };
}

module.exports = {
  createAuthUtils,
};
