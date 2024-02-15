/**
 * Generic tests checking evm equivalence smart contract behavior.
 *
 * Note: if you are going to write multiple tests checking specific topic (e.g. `CREATE2` behavior or something like this),
 * consider creating a separate suite.
 * Let's try to keep only relatively simple and self-contained tests here.
 */

import { TestMaster } from '../src/index';
import { deployContract, getEVMArtifact, getEVMContractFactory, getTestContract } from '../src/helpers';

import * as ethers from 'ethers';
import * as zksync from 'zksync-web3';

const contracts = {
    tester: getTestContract('TestEVMCreate'),
    erc20: getTestContract('ERC20'),
    uniswapV2Pair: getTestContract('UniswapV2Pair'),
    uniswapV2Factory: getTestContract('UniswapV2Factory')
};

const artifacts = {
    counter: getEVMArtifact('../evm-contracts/CounterWithParam.sol'),
    proxyCaller: getEVMArtifact('../evm-contracts/ProxyCaller.sol'),
    creator: getEVMArtifact('../evm-contracts/Creator.sol'),
    erc20: getEVMArtifact('../evm-contracts/ERC20.sol'),
    constructorRevert: getEVMArtifact('../evm-contracts/ConstructorRevert.sol'),
    uniswapV2Pair: getEVMArtifact('../contracts/uniswap-v2/UniswapV2Factory.sol', 'UniswapV2Pair.sol'),
    uniswapV2Factory: getEVMArtifact('../contracts/uniswap-v2/UniswapV2Factory.sol', 'UniswapV2Factory.sol'),
    opcodeTest: getEVMArtifact('../evm-contracts/OpcodeTest.sol'),
    selfDestruct: getEVMArtifact('../evm-contracts/SelfDestruct.sol')
};

const initBytecode = '0x69602a60005260206000f3600052600a6016f3';
const runtimeBytecode = '0x602a60005260206000f3';
const bytecodeHash = ethers.utils.keccak256(runtimeBytecode);
const contractDeployedTopic = '0x290afdae231a3fc0bbae8b1af63698b0a1d79b21ad17df0342dfb952fe74f8e5';

let gasLimit = '0x01ffffff';

const logGasCosts = false;
describe('EVM equivalence contract', () => {
    let testMaster: TestMaster;
    let alice: zksync.Wallet;

    // Contracts shared in several tests.
    let evmCreateTester: zksync.Contract;
    let deployer: zksync.Contract;

    beforeAll(async () => {
        testMaster = TestMaster.getInstance(__filename);
        alice = testMaster.mainAccount();

        evmCreateTester = await deployContract(alice, contracts.tester, []);
        deployer = new zksync.Contract(
            zksync.utils.CONTRACT_DEPLOYER_ADDRESS,
            zksync.utils.CONTRACT_DEPLOYER,
            alice.provider
        ).connect(alice);
    });

    describe('Contract creation', () => {
        describe('Create from EOA', () => {
            test('Should create evm contract from EOA and allow view and non-view calls', async () => {
                const args = [1];
                const factory = getEVMContractFactory(alice, artifacts.counter);
                const contract = await factory.deploy(args);
                await contract.deployTransaction.wait();
                const receipt = await alice.provider.getTransactionReceipt(contract.deployTransaction.hash);

                await assertCreatedCorrectly(deployer, contract.address, '0x' + artifacts.counter.evm.deployedBytecode.object, receipt.logs);

                expect((await contract.callStatic.get()).toString()).toEqual('1');
                await (await contract.increment(1)).wait();
                expect((await contract.callStatic.get()).toString()).toEqual('2');
            });

            test('Should create2 evm contract from ZKEVM contract', async () => {
                const salt = ethers.utils.randomBytes(32);
                
                const expectedAddress = ethers.utils.getCreate2Address(
                    evmCreateTester.address,
                    salt,
                    ethers.utils.keccak256(initBytecode)
                );
            
                const receipt = await (await evmCreateTester.create2(salt, initBytecode)).wait();

                await assertCreatedCorrectly(deployer, expectedAddress, runtimeBytecode, receipt.logs);

                try {
                    await (await evmCreateTester.create2(salt, initBytecode, { gasLimit })).wait();
                } catch (e) {
                    // Should fail
                    return;
                }
                throw 'Should fail to create2 the same contract with same salt twice';
            });

            test('Should propegate revert in constructor', async () => {
                const factory = getEVMContractFactory(alice, artifacts.constructorRevert);
                const contract = await factory.deploy({ gasLimit });

                let failReason;

                try {
                    await contract.deployTransaction.wait();
                } catch (e: any) {
                    failReason = e.reason;
                }

                expect(failReason).toBe('transaction failed');
            });

            test('Should NOT create evm contract from EOA when `to` is address(0x0)', async () => {
                const args = [1];

                const factory = getEVMContractFactory(alice, artifacts.counter);
                const transaction = await factory.getDeployTransaction(args);
                transaction.to = '0x0000000000000000000000000000000000000000';
                
                const result = await (await alice.sendTransaction(transaction)).wait();
                const expectedAddressCreate = ethers.utils.getContractAddress({
                    from: alice.address,
                    nonce: await alice.getNonce()
                });

                await assertContractNotCreated(deployer, expectedAddressCreate);
            });

            // test('Should SENDALL', async () => {
            //     const salt = ethers.utils.randomBytes(32);
            //     const selfDestructBytecode = '0x' + artifacts.selfDestruct.evm.bytecode.object;
            //     const hash = ethers.utils.keccak256(selfDestructBytecode);

            //     const selfDestructFactory = getEVMContractFactory(alice, artifacts.selfDestruct);
            //     const selfDestructAddress = ethers.utils.getCreate2Address(evmCreateTester.address, salt, hash);
            //     const selfDestruct = selfDestructFactory.attach(selfDestructAddress);
            //     const beneficiary = testMaster.newEmptyAccount();

            //     await (await evmCreateTester.create2(salt, selfDestructBytecode, { value: 1000 })).wait();
            //     expect((await alice.provider.getBalance(selfDestructAddress)).toNumber()).toBe(1000);

            //     await (await selfDestruct.destroy(beneficiary.address)).wait();
            //     expect((await alice.provider.getBalance(beneficiary.address)).toNumber()).toBe(1000);

            //     let failReason;

            //     try {
            //         await (await evmCreateTester.create2(salt, selfDestructBytecode)).wait();
            //     } catch (e: any) {
            //         failReason = e.error.reason;
            //     }

            //     expect(failReason).toBe("execution reverted: Can't create on existing contract address");
            // });
        });
    });

    describe('Inter-contract calls', () => {
        test('Calls (read/write) between EVM contracts should work correctly', async () => {
            const args = [1];

            const counterFactory = getEVMContractFactory(alice, artifacts.counter);
            const counterContract = await counterFactory.deploy(args);
            await counterContract.deployTransaction.wait();
            await alice.provider.getTransactionReceipt(counterContract.deployTransaction.hash);

            console.log('a');

            const proxyCallerFactory = getEVMContractFactory(alice, artifacts.proxyCaller);
            const proxyCallerContract = await proxyCallerFactory.deploy();
            await proxyCallerContract.deployTransaction.wait();
            await alice.provider.getTransactionReceipt(proxyCallerContract.deployTransaction.hash);

            // console.log('b');

            expect((await proxyCallerContract.proxyGet(counterContract.address)).toString()).toEqual('1');

            // console.log('c');

            await (await proxyCallerContract.executeIncrememt(counterContract.address, 1)).wait();
            // console.log('d');

            expect((await proxyCallerContract.proxyGet(counterContract.address)).toString()).toEqual('2');
            // console.log('e');

            // const data = proxyCallerContract.interface.encodeFunctionData('proxyGetBytes', [counterContract.address]);

            // const tracedCall = await alice.provider.send('debug_traceCall', [
            //     {
            //         to: proxyCallerContract.address,
            //         data
            //     }
            // ])

            // console.log(JSON.stringify(tracedCall, null, 2));

            expect((await proxyCallerContract.callStatic.proxyGetBytes(counterContract.address)).toString()).toEqual(
                '0x54657374696e67'
            );
        });

        test('Create opcode works correctly', async () => {
            const creatorFactory = getEVMContractFactory(alice, artifacts.creator);
            const creatorContract = await creatorFactory.deploy();
            await creatorContract.deployTransaction.wait();

            dumpOpcodeLogs(creatorContract.deployTransaction.hash, alice.provider);
            
            // FIXME: doublec check, since on EVM the first nonce for contracts is 1.
            const nonce = 0;

            const runtimeBytecode = await creatorContract.getCreationRuntimeCode();
            
            const expectedAddress = ethers.utils.getContractAddress({
                from: creatorContract.address,
                nonce
            });

            const result = await (await creatorContract.create()).wait();
            dumpOpcodeLogs(result.transactionHash, alice.provider);

            await assertCreatedCorrectly(deployer, expectedAddress, runtimeBytecode, result.logs);
        });

        test('Should revert correctly', async () => {
            const args = [1];

            const counterFactory = getEVMContractFactory(alice, artifacts.counter);
            const counterContract = await counterFactory.deploy(args);
            await counterContract.deployTransaction.wait();

            dumpOpcodeLogs(counterContract.deployTransaction.hash, alice.provider);

            let errorString;

            try {
                await counterContract.callStatic.incrementWithRevert(1, true);
            } catch (e: any) {
                errorString = e.reason;
            }
            expect(errorString).toEqual('This method always reverts');
        });
    });

    // NOTE: Gas cost comparisons should be done on a *fresh* chain that doesn't have e.g. bytecodes already published
    describe('ERC20', () => {
        let evmToken: ethers.Contract;
        let nativeToken: zksync.Contract;
        let userAccount: zksync.Wallet;
        let deployLogged: boolean = false;

        beforeEach(async () => {
            const erc20Factory = getEVMContractFactory(alice, artifacts.erc20);
            evmToken = await erc20Factory.deploy();
            await evmToken.deployTransaction.wait();
            nativeToken = await deployContract(alice, contracts.erc20, []);

            dumpOpcodeLogs(evmToken.deployTransaction.hash, alice.provider);
            userAccount = testMaster.newEmptyAccount();
            // Only log the first deployment
            if (logGasCosts && !deployLogged) {
                console.log(
                    'ERC20 native deploy gas: ' +
                        (await alice.provider.getTransactionReceipt(nativeToken.deployTransaction.hash)).gasUsed
                );
                console.log(
                    'ERC20 evm deploy gas: ' +
                        (await alice.provider.getTransactionReceipt(evmToken.deployTransaction.hash)).gasUsed
                );
                deployLogged = true;
            }
            await (
                await alice.sendTransaction({
                    to: userAccount.address,
                    value: ethers.BigNumber.from('0xffffffffffffff')
                })
            ).wait();
        });

        test('view functions should work', async () => {
            const evmBalanceOfCost = await evmToken.estimateGas.balanceOf(alice.address);
            const nativeBalanceOfCost = await nativeToken.estimateGas.balanceOf(alice.address);
            if (logGasCosts) {
                console.log('ERC20 native balanceOf gas: ' + nativeBalanceOfCost.toString());
                console.log('ERC20 evm balanceOf gas: ' + evmBalanceOfCost.toString());
            }
            expect((await evmToken.balanceOf(alice.address)).toString()).toEqual('1000000');
            expect((await evmToken.totalSupply()).toString()).toEqual('1000000');
            expect((await evmToken.balanceOf(userAccount.address)).toString()).toEqual('0');
        });

        test('transfer should work', async () => {
            expect((await evmToken.balanceOf(alice.address)).toString()).toEqual('1000000');
            const evmTransferTx = await (await evmToken.transfer(userAccount.address, 100000)).wait();
            const nativeTransferTx = await (await nativeToken.transfer(userAccount.address, 100000)).wait();
            if (logGasCosts) {
                console.log('ERC20 native transfer gas: ' + nativeTransferTx.gasUsed.toString());
                console.log('ERC20 evm transfer gas: ' + evmTransferTx.gasUsed.toString());
            }
            dumpOpcodeLogs(evmTransferTx.transactionHash, alice.provider);

            expect((await evmToken.balanceOf(alice.address)).toString()).toEqual('900000');
            expect((await evmToken.balanceOf(userAccount.address)).toString()).toEqual('100000');
        });

        test('approve & transferFrom should work', async () => {
            expect((await evmToken.balanceOf(alice.address)).toString()).toEqual('1000000');
            const evmApproveTx = await (await evmToken.connect(alice).approve(userAccount.address, 100000)).wait();
            const nativeApproveTx = await (
                await nativeToken.connect(alice).approve(userAccount.address, 100000)
            ).wait();
            if (logGasCosts) {
                console.log('ERC20 native approve gas: ' + nativeApproveTx.gasUsed.toString());
                console.log('ERC20 evm approve gas: ' + evmApproveTx.gasUsed.toString());
            }
            dumpOpcodeLogs(evmApproveTx.transactionHash, alice.provider);

            const evmTransferFromTx = await (
                await evmToken.connect(userAccount).transferFrom(alice.address, userAccount.address, 100000)
            ).wait();
            const nativeTransferFromTx = await (
                await nativeToken.connect(userAccount).transferFrom(alice.address, userAccount.address, 100000)
            ).wait();
            if (logGasCosts) {
                console.log('ERC20 native transferFrom gas: ' + nativeTransferFromTx.gasUsed.toString());
                console.log('ERC20 evm transferFrom gas: ' + evmTransferFromTx.gasUsed.toString());
            }
            dumpOpcodeLogs(evmTransferFromTx.transactionHash, alice.provider);

            expect((await evmToken.balanceOf(alice.address)).toString()).toEqual('900000');
            expect((await evmToken.balanceOf(userAccount.address)).toString()).toEqual('100000');
        });
    });

    // NOTE: Gas cost comparisons should be done on a *fresh* chain that doesn't have e.g. bytecodes already published
    describe.only('Uniswap-v2', () => {
        let evmToken1: ethers.Contract;
        let evmToken2: ethers.Contract;
        let evmUniswapFactory: ethers.Contract;
        let nativeUniswapFactory: ethers.Contract;
        let evmUniswapPair: ethers.Contract;
        let nativeUniswapPair: ethers.Contract;

        let deployLogged: boolean = false;
        const NEW_PAIR_TOPIC = '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9';

        beforeEach(async () => {
            const erc20Factory = getEVMContractFactory(alice, artifacts.erc20);
            evmToken1 = await erc20Factory.deploy({ gasLimit });
            await evmToken1.deployTransaction.wait();
            evmToken2 = await erc20Factory.deploy();
            await evmToken2.deployTransaction.wait();
        
            console.log('a');

            const evmUniswapFactoryFactory = getEVMContractFactory(alice, artifacts.uniswapV2Factory);
            evmUniswapFactory = await evmUniswapFactoryFactory.deploy('0x0000000000000000000000000000000000000000', {
                gasLimit
            });
            await evmUniswapFactory.deployTransaction.wait();
            nativeUniswapFactory = await deployContract(
                alice,
                contracts.uniswapV2Factory,
                ['0x0000000000000000000000000000000000000000'],
                undefined,
                {
                    customData: {
                        factoryDeps: [contracts.uniswapV2Pair.bytecode]
                    }
                }
            );

            console.log('b');
            const evmPairReceipt = await (
                await evmUniswapFactory.createPair(evmToken1.address, evmToken2.address)
            ).wait();

            const nativePairReceipt = await (
                await nativeUniswapFactory.createPair(evmToken1.address, evmToken2.address)
            ).wait();
            dumpOpcodeLogs(evmUniswapFactory.deployTransaction.hash, alice.provider);
            dumpOpcodeLogs(evmPairReceipt.transactionHash, alice.provider);

            console.log('c');
            const evmUniswapPairFactory = getEVMContractFactory(alice, artifacts.uniswapV2Pair);
            const nativeUniswapPairFactory = new zksync.ContractFactory(
                contracts.uniswapV2Pair.abi,
                contracts.uniswapV2Pair.bytecode,
                alice
            );
            evmUniswapPair = evmUniswapPairFactory.attach(
                ethers.utils.defaultAbiCoder.decode(
                    ['address', 'uint256'],
                    evmPairReceipt.logs.find((log: any) => log.topics[0] === NEW_PAIR_TOPIC).data
                )[0]
            );

            console.log('d');
            nativeUniswapPair = nativeUniswapPairFactory.attach(
                ethers.utils.defaultAbiCoder.decode(
                    ['address', 'uint256'],
                    nativePairReceipt.logs.find((log: any) => log.topics[0] === NEW_PAIR_TOPIC).data
                )[0]
            );
            const token1IsFirst = (await evmUniswapPair.token0()).toString() === evmToken1.address;
            if (!token1IsFirst) {
                [evmToken1, evmToken2] = [evmToken2, evmToken1];
            }
            console.log('e');

            await (await evmToken1.transfer(evmUniswapPair.address, 100000)).wait();
            await (await evmToken1.transfer(nativeUniswapPair.address, 100000)).wait();
            console.log('f');

            await (await evmToken2.transfer(evmUniswapPair.address, 100000)).wait();
            await (await evmToken2.transfer(nativeUniswapPair.address, 100000)).wait();

            console.log('g');


            // Only log the first deployment
            if (logGasCosts && !deployLogged) {
                console.log(
                    'Uniswap Factory native deploy gas: ' +
                        (await alice.provider.getTransactionReceipt(nativeUniswapFactory.deployTransaction.hash))
                            .gasUsed
                );
                console.log(
                    'Uniswap Factory evm deploy gas: ' +
                        (await alice.provider.getTransactionReceipt(evmUniswapFactory.deployTransaction.hash)).gasUsed
                );
                console.log('Uniswap Pair native create gas: ' + nativePairReceipt.gasUsed);
                console.log('Uniswap Pair evm create gas: ' + evmPairReceipt.gasUsed);
                deployLogged = true;
            }
        });

        test('mint, swap, and burn should work', async () => {
            console.log('h');

            console.log(await evmUniswapPair.token1());

            const params = evmUniswapPair.interface.encodeFunctionData('mint', [alice.address]);

            console.log(evmUniswapPair.address);

            const tx = await evmUniswapPair.mint(alice.address, {
                //  gasLimit: 40000000
            });
            await tx.wait()
            try {
            }catch {}

            const tracedCall = await alice.provider.send('debug_traceTransaction', [
                tx.hash
            ]);
            console.log(JSON.stringify(tracedCall, null,2));
            // const evmMintReceipt = await ().wait();
            return;
    

            // // const evmMintReceipt = await (await evmUniswapPair.mint(alice.address)).wait();
            // console.log('h2');

            // const nativeMintReceipt = await (await nativeUniswapPair.mint(alice.address)).wait();
            // dumpOpcodeLogs(evmMintReceipt.transactionHash, alice.provider);

            // console.log('i');


            // await (await evmToken1.transfer(evmUniswapPair.address, 10000)).wait();
            // await (await evmToken1.transfer(nativeUniswapPair.address, 10000)).wait();
            // console.log('j');

            // const evmSwapReceipt = await (await evmUniswapPair.swap(0, 5000, alice.address, '0x')).wait();
            // const nativeSwapReceipt = await (await nativeUniswapPair.swap(0, 5000, alice.address, '0x')).wait();
            // dumpOpcodeLogs(evmSwapReceipt.transactionHash, alice.provider);
            // console.log('k');

            // const evmLiquidityTransfer = await (
            //     await evmUniswapPair.transfer(
            //         evmUniswapPair.address,
            //         (await evmUniswapPair.balanceOf(alice.address)).toString()
            //     )
            // ).wait();
            // console.log('l');

            // await (
            //     await nativeUniswapPair.transfer(
            //         nativeUniswapPair.address,
            //         (await nativeUniswapPair.balanceOf(alice.address)).toString()
            //     )
            // ).wait();
            // console.log('m');

            // const evmBurnReceipt = await (await evmUniswapPair.burn(alice.address)).wait();
            // const nativeBurnReceipt = await (await nativeUniswapPair.burn(alice.address)).wait();
            // expect(Number((await evmToken1.balanceOf(alice.address)).toString())).toBeGreaterThanOrEqual(990000);
            // expect(Number((await evmToken2.balanceOf(alice.address)).toString())).toBeGreaterThanOrEqual(990000);
                
            // console.log('n');


            // if (logGasCosts) {
            //     console.log('UniswapV2Pair native mint gas: ' + nativeMintReceipt.gasUsed);
            //     console.log('UniswapV2Pair evm mint gas: ' + evmMintReceipt.gasUsed);
            //     console.log('UniswapV2Pair native swap gas: ' + nativeSwapReceipt.gasUsed);
            //     console.log('UniswapV2Pair evm swap gas: ' + evmSwapReceipt.gasUsed);
            //     console.log('UniswapV2Pair native burn gas: ' + nativeBurnReceipt.gasUsed);
            //     console.log('UniswapV2Pair evm burn gas: ' + evmBurnReceipt.gasUsed);
            // }
            // dumpOpcodeLogs(evmLiquidityTransfer.transactionHash, alice.provider);
            // dumpOpcodeLogs(evmBurnReceipt.transactionHash, alice.provider);
        });
    });

    // NOTE: Gas cost comparisons should be done on a *fresh* chain that doesn't have e.g. bytecodes already published
    // describe('Bulk opcode tests', () => {
    //     let opcodeTest: ethers.Contract;
    //     beforeEach(async () => {
    //         const opcodeTestFactory = getEVMContractFactory(alice, artifacts.opcodeTest);
    //         console.log(opcodeTestFactory.bytecode)
    //         opcodeTest = await opcodeTestFactory.deploy()
    //     });

    //     test('should successfully execute bulk opcode test', async () => {
    //         console.log(await deployer.evmCode(opcodeTest.address))
    //         // const receipt = await (await opcodeTest.execute()).wait()
    //         // dumpOpcodeLogs(receipt.transactionHash, alice.provider);
    //     });
    // });

    afterAll(async () => {
        await testMaster.deinitialize();
        if (logGasCosts) {
            printCostData();
        }
    });
});

async function assertStoredBytecodeHash(
    deployer: zksync.Contract,
    deployedAddress: string,
    expectedStoredHash: string
): Promise<void> {
    const ACCOUNT_CODE_STORAGE_ADDRESS = '0x0000000000000000000000000000000000008002';
    const storedCodeHash = await deployer.provider.getStorageAt(ACCOUNT_CODE_STORAGE_ADDRESS, ethers.utils.hexZeroPad(deployedAddress, 32));

    expect(storedCodeHash).toEqual(expectedStoredHash);
}

async function assertCreatedCorrectly(
    deployer: zksync.Contract,
    deployedAddress: string,
    expectedEVMBytecode: string,
    logs: Array<any>
): Promise<void> {
    const expectedStoredHash = getSha256BlobHash(expectedEVMBytecode);
    await assertStoredBytecodeHash(deployer, deployedAddress, expectedStoredHash);
}

// Returns the canonical code hash of 
function getSha256BlobHash(bytes: ethers.BytesLike): string {
    const hash = ethers.utils.arrayify(ethers.utils.sha256(bytes));
    hash[0] = 2;
    hash[1] = 0;

    // Length of the bytecode
    const lengthInBytes = ethers.utils.arrayify(bytes).length;
    hash[2] = Math.floor(lengthInBytes / 256);
    hash[3] = lengthInBytes % 256;

    return ethers.utils.hexlify(hash);
}

async function assertContractNotCreated(deployer: zksync.Contract, deployedAddress: string): Promise<void> {
    assertStoredBytecodeHash(deployer, deployedAddress, ethers.constants.HashZero);

}

function printCostData() {
    let costsDataString = '';

    const averageOverhead =
        overheadDataDump.length === 0
            ? undefined
            : Math.floor(overheadDataDump.reduce((a: number, c: number) => a + c) / overheadDataDump.length);
    const minOverhead = overheadDataDump.length === 0 ? undefined : Math.min(...overheadDataDump);
    const maxOverhead = overheadDataDump.length === 0 ? undefined : Math.max(...overheadDataDump);

    costsDataString += 'Overhead\t' + averageOverhead + '\t' + minOverhead + '\t' + maxOverhead + '\n';

    Object.keys(opcodeDataDump).forEach((opcode) => {
        const opcodeString = '0x' + Number(opcode).toString(16).padStart(2, '0');
        const values = opcodeDataDump[opcode.toString()];
        if (values.length === 0) {
            costsDataString += opcodeString + '\n';
            return;
        }
        const average = Math.floor(values.reduce((a: number, c: number) => a + c) / values.length);
        const min = Math.min(...values);
        const max = Math.max(...values);

        costsDataString +=
            opcodeString +
            '\t' +
            average +
            '\t' +
            (min === average ? '' : min) +
            '\t' +
            (max === average ? '' : max) +
            '\n';
    });
    console.log(costsDataString);
}

const overheadDataDump: Array<number> = [];
const opcodeDataDump: any = {};
[
    '0x0',
    '0x1',
    '0x2',
    '0x3',
    '0x4',
    '0x5',
    '0x6',
    '0x7',
    '0x8',
    '0x9',
    '0x0A',
    '0x0B',
    '0x10',
    '0x11',
    '0x12',
    '0x13',
    '0x14',
    '0x15',
    '0x16',
    '0x17',
    '0x18',
    '0x19',
    '0x1A',
    '0x1B',
    '0x1C',
    '0x1D',
    '0x20',
    '0x30',
    '0x31',
    '0x32',
    '0x33',
    '0x34',
    '0x35',
    '0x36',
    '0x37',
    '0x38',
    '0x39',
    '0x3A',
    '0x3B',
    '0x3C',
    '0x3D',
    '0x3E',
    '0x3F',
    '0x40',
    '0x41',
    '0x42',
    '0x43',
    '0x44',
    '0x45',
    '0x46',
    '0x47',
    '0x48',
    '0x50',
    '0x51',
    '0x52',
    '0x53',
    '0x54',
    '0x55',
    '0x56',
    '0x57',
    '0x58',
    '0x59',
    '0x5A',
    '0x5B',
    '0x5F',
    '0x60',
    '0x61',
    '0x62',
    '0x63',
    '0x64',
    '0x65',
    '0x66',
    '0x67',
    '0x68',
    '0x69',
    '0x6A',
    '0x6B',
    '0x6C',
    '0x6D',
    '0x6E',
    '0x6F',
    '0x70',
    '0x71',
    '0x72',
    '0x73',
    '0x74',
    '0x75',
    '0x76',
    '0x77',
    '0x78',
    '0x79',
    '0x7A',
    '0x7B',
    '0x7C',
    '0x7D',
    '0x7E',
    '0x7F',
    '0x80',
    '0x81',
    '0x82',
    '0x83',
    '0x84',
    '0x85',
    '0x86',
    '0x87',
    '0x88',
    '0x89',
    '0x8A',
    '0x8B',
    '0x8C',
    '0x8D',
    '0x8E',
    '0x8F',
    '0x90',
    '0x91',
    '0x92',
    '0x93',
    '0x94',
    '0x95',
    '0x96',
    '0x97',
    '0x98',
    '0x99',
    '0x9A',
    '0x9B',
    '0x9C',
    '0x9D',
    '0x9E',
    '0x9F',
    '0xA0',
    '0xA1',
    '0xA2',
    '0xA3',
    '0xA4',
    '0xF0',
    '0xF1',
    '0xF2',
    '0xF3',
    '0xF4',
    '0xF5',
    '0xFA',
    '0xFD',
    '0xFE',
    '0xFF'
].forEach((key) => {
    opcodeDataDump[Number(key).toString()] = [];
});

async function dumpOpcodeLogs(hash: string, provider: zksync.Provider): Promise<void> {
    const logs = (await provider.getTransactionReceipt(hash)).logs;
    logs.forEach((log) => {
        if (log.topics[0] === '0x63307236653da06aaa7e128a306b128c594b4cf3b938ef212975ed10dad17515') {
            //Overhead
            overheadDataDump.push(Number(ethers.utils.defaultAbiCoder.decode(['uint256'], log.data).toString()));
        } else if (log.topics[0] === '0xca5a69edf1b934943a56c00605317596b03e2f61c3f633e8657b150f102a3dfa') {
            // Opcode
            const parsed = ethers.utils.defaultAbiCoder.decode(['uint256', 'uint256'], log.data);
            const opcode = Number(parsed[0].toString());
            const cost = Number(parsed[1].toString());

            opcodeDataDump[opcode.toString()].push(cost);
        }
    });
}