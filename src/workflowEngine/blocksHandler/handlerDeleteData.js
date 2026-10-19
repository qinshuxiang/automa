import dbStorage from '@/db/storage';

function deleteData({ data, id }) {
  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async (resolve) => {
    let variableDeleted = false;
    const persistTasks = [];

    data.deleteList.forEach((item) => {
      if (item.type === 'table') {
        if (item.columnId === '[all]') {
          this.engine.referenceData.table = [];

          Object.keys(this.engine.columns).forEach((key) => {
            this.engine.columns[key].index = 0;
          });
        } else {
          const columnName = this.engine.columns[item.columnId].name;

          this.engine.referenceData.table.forEach((_, index) => {
            const row = this.engine.referenceData.table[index];
            delete row[columnName];

            if (!row || Object.keys(row).length === 0) {
              this.engine.referenceData.table[index] = {};
            }
          });

          this.engine.columns[item.columnId].index = 0;
        }
      } else if (item.variableName) {
        // $$ 持久变量先经 setVariable 统一入口清值，再删除 IndexedDB 记录，
        // 否则下次执行会从存储里复活已删除的变量
        if (item.variableName.startsWith('$$')) {
          persistTasks.push(async () => {
            try {
              if (typeof this.setVariable === 'function') {
                await this.setVariable(item.variableName, undefined);
              }

              const record = await dbStorage.variables.get({
                name: item.variableName.slice(2),
              });
              if (record) await dbStorage.variables.delete(record.id);
            } catch (error) {
              console.error('删除持久变量失败:', error);
            }
          });
        }

        delete this.engine.referenceData.variables[item.variableName];
        variableDeleted = true;
      }
    });

    // F05 修复：persistTasks 存的是 thunk，必须在 allSettled 处调用，
    // 否则 Promise.allSettled 收到的是函数而非 Promise，任务体永不执行
    if (persistTasks.length) {
      await Promise.allSettled(persistTasks.map((task) => task()));
    }

    if (variableDeleted) this.engine.addRefDataSnapshot('variables');

    resolve({
      data: '',
      nextBlockId: this.getBlockConnections(id),
    });
  });
}

export default deleteData;
