export const BLOCK_SIZE_BYTES = 4;
export const BLOCK_COUNT_BYTES = 4;

export const HEADER_SIZE = BLOCK_SIZE_BYTES + BLOCK_COUNT_BYTES;

export const ADLER_32_BYTES = 4;
export const MD5_BYTES = 16;

export const CHUNK_SIZE = ADLER_32_BYTES + MD5_BYTES;

export const syncFileName = ".fullstacked-sync";