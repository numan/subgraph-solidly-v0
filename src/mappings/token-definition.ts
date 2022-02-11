import {
    Address,
    BigInt,
  } from "@graphprotocol/graph-ts"
  
  // Initialize a Token Definition with the attributes
  export class TokenDefinition {
    address : Address
    symbol: string
    name: string
    decimals: BigInt
  
    // Initialize a Token Definition with its attributes
    constructor(address: Address, symbol: string, name: string, decimals: BigInt) {
      this.address = address
      this.symbol = symbol
      this.name = name
      this.decimals = decimals
    }
  
    // Get all tokens with a static definition
    static getStaticDefinitions(): Array<TokenDefinition> {
      let staticDefinitions = new Array<TokenDefinition>(6)
  
      // Add wFTM
      let tokenWFTM = new TokenDefinition(
        Address.fromString('0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83'),
        'wFTM',
        'wFTM',
        BigInt.fromI32(18)
      )
      staticDefinitions.push(tokenWFTM)
  
      return staticDefinitions
    }
  
    // Helper for hardcoded tokens
    static fromAddress(tokenAddress: Address) : TokenDefinition | null {
      let staticDefinitions = this.getStaticDefinitions()
      let tokenAddressHex = tokenAddress.toHexString()
  
      // Search the definition using the address
      for (let i = 0; i < staticDefinitions.length; i++) {
        let staticDefinition = staticDefinitions[i]
        if(staticDefinition.address.toHexString() == tokenAddressHex) {
          return staticDefinition
        }
      }
  
      // If not found, return null
      return null
    }
  
  }