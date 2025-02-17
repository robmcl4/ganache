import { BN } from "ethereumjs-util";
import { RuntimeError, RETURN_TYPES } from "@ganache/ethereum-utils";
import { RPCQUANTITY_EMPTY } from "@ganache/utils";

const bn = (val = 0) => new (BN as any)(val);
const STIPEND = bn(2300);
const MULTIPLE = 64 / 63;

const check = set => opname => set.has(opname);
const isCall = check(
  new Set(["CALL", "DELEGATECALL", "STATICCALL", "CALLCODE"])
);
const isCallOrCallcode = check(new Set(["CALL", "CALLCODE"]));
const isCreate = check(new Set(["CREATE", "CREATE2"]));
const isTerminator = check(
  new Set(["STOP", "RETURN", "REVERT", "INVALID", "SELFDESTRUCT"])
);

const stepTracker = () => {
  const sysOps = [];
  const allOps = [];
  const preCompile = new Set();
  let preCompileCheck = false;
  let precompileCallDepth = 0;
  return {
    collect: info => {
      if (preCompileCheck) {
        if (info.depth === precompileCallDepth) {
          // If the current depth is unchanged.
          // we record its position.
          preCompile.add(allOps.length - 1);
        }
        // Reset the flag immediately here
        preCompileCheck = false;
      }
      if (isCall(info.opcode.name)) {
        info.stack = info.stack.map(val => val.clone());
        preCompileCheck = true;
        precompileCallDepth = info.depth;
        sysOps.push({
          index: allOps.length,
          depth: info.depth,
          name: info.opcode.name
        });
      } else if (isCreate(info.opcode.name) || isTerminator(info.opcode.name)) {
        sysOps.push({
          index: allOps.length,
          depth: info.depth,
          name: info.opcode.name
        });
      }
      // This goes last so we can use the length for the index ^
      allOps.push(info);
    },
    isPrecompile: index => preCompile.has(index),
    done: () =>
      !allOps.length ||
      sysOps.length < 2 ||
      !isTerminator(allOps[allOps.length - 1].opcode.name),
    ops: allOps,
    systemOps: sysOps
  };
};

const estimateGas = (generateVM, runArgs, callback) => {
  exactimate(generateVM(), runArgs, (err, result) => {
    if (err) return callback(err);
    binSearch(generateVM, runArgs, result, (err, result) => {
      if (err) return callback(err);
      callback(null, result);
    });
  });
};

const binSearch = async (generateVM, runArgs, result, callback) => {
  const MAX = runArgs.block.header.gasLimit;
  const gasRefund = result.execResult.gasRefund;
  const startingGas = gasRefund
    ? result.gasEstimate.add(gasRefund)
    : result.gasEstimate;
  const range = { lo: startingGas, hi: startingGas };
  const isEnoughGas = async gas => {
    const vm = generateVM(); // Generate fresh VM
    runArgs.tx.gasLimit = new BN(gas.toArrayLike(Buffer));
    await vm.stateManager.checkpoint();
    const result = await vm.runTx(runArgs).catch(vmerr => ({ vmerr }));
    await vm.stateManager.revert();
    return !result.vmerr && !result.execResult.exceptionError;
  };

  if (!(await isEnoughGas(range.hi))) {
    do {
      range.hi = range.hi.muln(MULTIPLE);
    } while (!(await isEnoughGas(range.hi)));
    while (range.lo.addn(1).lt(range.hi)) {
      const mid = range.lo.add(range.hi).divn(2);
      if (await isEnoughGas(mid)) {
        range.hi = mid;
      } else {
        range.lo = mid;
      }
    }
    if (range.hi.gte(MAX)) {
      if (!(await isEnoughGas(range.hi))) {
        return callback(
          new Error(
            "gas required exceeds allowance or always failing transaction"
          )
        );
      }
    }
  }

  result.gasEstimate = range.hi;
  callback(null, result);
};

const exactimate = async (vm, runArgs, callback) => {
  const steps = stepTracker();
  vm.on("step", steps.collect);

  const Context = (index: number, fee?: BN) => {
    const base = index === 0;
    let start = index;
    let stop = 0;
    const cost = bn();
    let sixtyFloorths = bn();
    const op = steps.ops[index];
    const next = steps.ops[index + 1];
    const intermediateCost = op.gasLeft.sub(next.gasLeft);
    const callingFee = fee || bn();
    let compositeContext = false;

    function addGas(val) {
      // Add to our current context, but accounted for in sixtyfloorths
      if (sixtyFloorths.gtn(0)) {
        if (val.gte(sixtyFloorths)) {
          sixtyFloorths = bn();
        } else {
          sixtyFloorths.isub(val);
        }
      }
      cost.iadd(val);
    }

    return {
      start: () => start,
      stop: () => stop,
      setStart: val => {
        start = val;
        compositeContext = true;
      },
      setStop: val => {
        stop = val;
      },
      getCost: () => ({ cost, sixtyFloorths }),
      transfer: ctx => {
        const values = ctx.getCost();
        addGas(values.cost);
        sixtyFloorths.iadd(values.sixtyFloorths);
      },
      addSixtyFloorth: sixtyFloorth => {
        sixtyFloorths.iadd(sixtyFloorth);
      },
      addRange: (fee = bn()) => {
        // only occurs on stack increasing ops
        addGas(
          steps.ops[base || compositeContext ? start : start + 1].gasLeft
            .sub(steps.ops[stop].gasLeft)
            .add(fee)
        );
      },
      finalizeRange: () => {
        let range;
        // if we have a composite context and we are NOT at the final terminator
        if (compositeContext && stop !== steps.ops.length - 1) {
          range = steps.ops[start].gasLeft.sub(steps.ops[stop - 1].gasLeft);
          addGas(range);
          const tail = steps.ops[stop - 1].gasLeft.sub(steps.ops[stop].gasLeft);
          range = tail.add(intermediateCost);
        } else {
          range = steps.ops[start].gasLeft.sub(steps.ops[stop].gasLeft);
        }
        range.isub(callingFee);
        addGas(range);
        if (
          isCallOrCallcode(op.opcode.name) &&
          !op.stack[op.stack.length - 3].isZero()
        ) {
          cost.iadd(sixtyFloorths);
          const innerCost = next.gasLeft.sub(steps.ops[stop - 1].gasLeft);
          if (innerCost.gt(STIPEND)) {
            sixtyFloorths = cost.divn(63);
          } else if (innerCost.lte(STIPEND)) {
            sixtyFloorths = STIPEND.sub(innerCost);
          }
        } else if (stop !== steps.ops.length - 1) {
          cost.iadd(sixtyFloorths);
          sixtyFloorths = cost.divn(63);
        }
      }
    };
  };

  const getTotal = () => {
    const sysops = steps.systemOps;
    const ops = steps.ops;
    const opIndex = cursor => sysops[cursor].index;
    const stack = [];
    let cursor = 0;
    let context = Context(0);
    while (cursor < sysops.length) {
      const currentIndex = opIndex(cursor);
      const current = ops[currentIndex];
      const name = current.opcode.name;
      if (isCall(name) || isCreate(name)) {
        if (steps.isPrecompile(currentIndex)) {
          context.setStop(currentIndex + 1);
          context.addRange();
          context.setStart(currentIndex + 1);
          context.addSixtyFloorth(STIPEND);
        } else {
          context.setStop(currentIndex);
          context.addRange(bn(current.opcode.fee));
          stack.push(context);
          context = Context(currentIndex, bn(current.opcode.fee)); // setup next context
        }
      } else if (isTerminator(name)) {
        // only on the last operation
        context.setStop(
          currentIndex + 1 < steps.ops.length ? currentIndex + 1 : currentIndex
        );
        context.finalizeRange();
        const ctx = stack.pop();
        if (ctx) {
          ctx.transfer(context);
          context = ctx;
          context.setStart(currentIndex + 1);
        } else {
          break;
        }
      } else {
        throw new Error("INVALID OPCODE");
      }
      cursor++;
    }
    const gas = context.getCost();
    return gas.cost.add(gas.sixtyFloorths);
  };
  await vm.stateManager.checkpoint();
  const result = await vm.runTx(runArgs).catch(vmerr => ({ vmerr }));
  await vm.stateManager.revert();
  const vmerr = result.vmerr;
  if (vmerr) {
    return callback(vmerr);
  } else if (result.execResult.exceptionError) {
    const error = new RuntimeError(
      // erroneous gas estimations don't have meaningful hashes
      RPCQUANTITY_EMPTY,
      result,
      RETURN_TYPES.RETURN_VALUE
    );
    return callback(error, result);
  } else if (steps.done()) {
    const estimate = result.gasUsed;
    result.gasEstimate = estimate;
  } else {
    const actualUsed = steps.ops[0].gasLeft.sub(
      steps.ops[steps.ops.length - 1].gasLeft
    );
    const sixtyFloorths = getTotal().sub(actualUsed);
    result.gasEstimate = result.gasUsed.add(sixtyFloorths);
  }
  callback(vmerr, result);
};

export default estimateGas;
