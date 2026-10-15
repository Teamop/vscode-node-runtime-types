export interface RuntimeTypesFolder {
  path?: string;
  supported: boolean;
  projectTypesVersion?: string;
  typesRoot?: string;
}

export interface RuntimeTypesPlan {
  enabled: boolean;
  typesRoot?: string;
  folders: Array<{ path: string; typesRoot: string }>;
}

/** Projects that already depend on @types/node keep that package and get no cache download. */
export function runtimeTypesPlan(folders: readonly RuntimeTypesFolder[], looseTypesRoot?: string): RuntimeTypesPlan {
  const supported = folders.filter((folder) => folder.supported);
  return {
    enabled: supported.length > 0 || looseTypesRoot !== undefined,
    typesRoot: looseTypesRoot,
    folders: supported.flatMap((folder) => {
      if (!folder.path || !folder.typesRoot || folder.projectTypesVersion) {
        return [];
      }
      return [{ path: folder.path, typesRoot: folder.typesRoot }];
    }),
  };
}
