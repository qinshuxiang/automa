function repeatTask({ data, id }) {
  return new Promise((resolve, reject) => {
    const repeat = +data.repeatFor;

    if (!Number.isInteger(repeat) || repeat < 0) {
      reject(new Error('重复次数必须是非负整数'));
      return;
    }

    if (
      repeat === 0 ||
      this.repeatedTasks[id] > repeat ||
      !this.getBlockConnections(id, 2)
    ) {
      delete this.repeatedTasks[id];

      resolve({
        data: repeat,
        nextBlockId: this.getBlockConnections(id),
      });
    } else {
      this.repeatedTasks[id] = (this.repeatedTasks[id] || 1) + 1;

      resolve({
        data: repeat,
        nextBlockId: this.getBlockConnections(id, 2),
      });
    }
  });
}

export default repeatTask;
