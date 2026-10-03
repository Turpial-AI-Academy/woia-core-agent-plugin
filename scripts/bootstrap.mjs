import { installLockedDependencies } from "./lib/toolchain-contract.mjs";

const toolchain = await installLockedDependencies();
console.log(`bootstrap: installed locked maintenance dependencies with Node ${toolchain.node} and pnpm ${toolchain.pnpm}`);
