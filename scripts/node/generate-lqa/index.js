const path = require('path');
const fs = require('fs/promises');
const { createEnv } = require('lua-in-js');
const { writeFileSync, mkdirSync } = require('fs');


const GAME_TABLE_DEFINE_URL = "https://github.com/MakoStar/ss-lua/raw/refs/heads/main/Lua/Game/CodeGen/GAME_TABLE_DEFINE.lua";


async function collectFiles(dir, filter) {
  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  const tasks = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      tasks.push(collectFiles(fullPath, filter));
    } else if (entry.isFile() && filter(fullPath)) {
      files.push(fullPath);
    }
  }

  const subResults = await Promise.all(tasks);
  return files.concat(...subResults);
}


async function readAndParse(filePath, basePath, encoding, strictJson) {
  const relativePath = path.relative(basePath, filePath).replace(/\\/g, '/');

  try {
    const data = await fs.readFile(filePath, encoding);

    if (relativePath.endsWith('.json')) {
      try {
        return [relativePath, JSON.parse(data)];
      } catch (e) {
        console.error(`JSON parse failed: ${relativePath}`, e.message);
        if (!strictJson) return [relativePath, data];
        return null;
      }
    }

    return [relativePath, data];
  } catch (err) {
    console.error(`Failed to read ${filePath}:`, err.message);
    return null;
  }
}


async function runWorkerPool(tasks, concurrency, workerFn) {
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < tasks.length) {
      const task = tasks[nextIndex++];
      await workerFn(task);
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker()
  );

  await Promise.all(workers);
}


async function buildDataFileMap(dirPath, options = {}) {
  const {
    concurrency = 20,
    filter = () => true,
    encoding = 'utf-8',
    basePath = dirPath,
    strictJson = false
  } = options;

  const map = new Map();
  const files = await collectFiles(dirPath, filter);

  const processTask = async (filePath) => {
    const result = await readAndParse(filePath, basePath, encoding, strictJson);
    if (result) {
      map.set(result[0], result[1]);
    }
  };

  await runWorkerPool(files, concurrency, processTask);
  return map;
}


function luaTableToJS(table) {
  if (!table || typeof table !== 'object' || !table.strValues) {
    return table;
  }

  const result = {};

  for (const [key, value] of Object.entries(table.strValues)) {
    result[key] = luaTableToJS(value);
  }

  if (table.numValues && table.numValues.length > 0) {
    const arr = [];
    // let isArray = true;

    for (let i = 0; i < table.numValues.length; i++) {
      const val = table.numValues[i];
      if (val !== undefined) {
        arr[i] = luaTableToJS(val);
      }
    }

    if (Object.keys(result).length === 0) {
      return arr.filter(v => v !== undefined);
    } else {
      arr.forEach((v, i) => {
        if (v !== undefined) result[String(i + 1)] = v;
      });
    }
  }

  return result;
}


async function getTableDefine(tableDefineUrl) {
  const response = await fetch(tableDefineUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${tableDefineUrl}`);
  }

  const luaTableDefineCode = await response.text();

  let tableDefineData;
  try {
    tableDefineData = createEnv().parse(luaTableDefineCode).exec();
  } catch (e) {
    throw new Error(`Lua parse error: ${e.message}`);
  }

  const { CommonTable } = luaTableToJS(tableDefineData);
  if (!CommonTable) {
    throw new Error('CommonTable not found in parsed Lua data');
  }

  return CommonTable;
}


(async () => { 
  const outputDor = "./generated_data";
  const repoDir = process.env.SS_DATA_DIR || path.resolve(__dirname, '../../../ss-data');
  // await cloneRepo(SS_DATA_REPO, repoDir);

  const jsonDataMapping = await buildDataFileMap(repoDir, {
    filter: (fp) => fp.endsWith('.json'),
    encoding: 'utf-8',
    concurrency: 30
  });

  const tableDefineData = await getTableDefine(GAME_TABLE_DEFINE_URL);

  const regionConfigs = [
    { key: "CN", value: "zh_CN" },
    { key: "EN", value: "en_US" },
    { key: "JP", value: "ja_JP" },
    { key: "KR", value: "ko_KR" },
    { key: "TW", value: "zh_TW" },
  ];

  for (const region of regionConfigs) {
    console.log(`Generating language.${region.value}.json`);
    const languageJson = {};
    for (const [tableKey, tableValue] of Object.entries(tableDefineData)) {
      const { Key, Lang } = luaTableToJS(tableValue) ?? {};
      if (!(Key && Array.isArray(Lang))) continue;

      const binPath = `${region.key}/bin/${tableKey}.json`;
      const lanPath = `${region.key}/language/${region.value}/${tableKey}.json`;

      const binData = jsonDataMapping.get(binPath);
      const lanData = jsonDataMapping.get(lanPath);

      if (!binData || !lanData) continue;

      for (const langItem of Lang) {
        for (const binItem of Object.values(binData)) {
          const lqaKey = binItem[langItem];
          const lqaValue = lanData[lqaKey];
          if (!lqaKey || !lqaValue) continue;
          languageJson[lqaKey] = lqaValue;
        }
      }
    }
    const filePath = `${outputDor}/language.${region.value}.json`;
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(languageJson, null, 4));
    console.log(`Saved ${filePath}`);
  }

})();
