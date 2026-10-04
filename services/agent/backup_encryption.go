package main

import (
 "crypto/aes"
 "crypto/cipher"
 "crypto/hmac"
 "crypto/rand"
 "crypto/sha256"
 "encoding/base64"
 "encoding/binary"
 "errors"
 "io"
 "os"
 "strings"
)

var backupEncryptionMagic=[]byte("CDBKENC1")
const backupEncryptionChunkSize=1024*1024
const backupEncryptionSaltSize=16
const backupEncryptionNoncePrefixSize=8

func backupEncryptionKey()([]byte,bool,error){
 raw:=strings.TrimSpace(os.Getenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY"))
 if raw==""{return nil,false,nil}
 key,err:=base64.StdEncoding.DecodeString(raw)
 if err!=nil||len(key)!=32{return nil,false,errors.New("CLOUDDECK_BACKUP_ENCRYPTION_KEY must be base64 for exactly 32 bytes")}
 return key,true,nil
}

func deriveBackupEncryptionKey(master,salt []byte)[]byte{
 mac:=hmac.New(sha256.New,master)
 _,_=mac.Write([]byte("clouddeck-backup-v1"))
 _,_=mac.Write(salt)
 return mac.Sum(nil)
}

func backupEncryptionAAD(salt []byte,counter uint32,plaintextLength uint32)[]byte{
 aad:=make([]byte,0,len(backupEncryptionMagic)+len(salt)+8)
 aad=append(aad,backupEncryptionMagic...)
 aad=append(aad,salt...)
 var values [8]byte
 binary.BigEndian.PutUint32(values[:4],counter)
 binary.BigEndian.PutUint32(values[4:],plaintextLength)
 return append(aad,values[:]...)
}

func backupEncryptionNonce(prefix []byte,counter uint32)[]byte{
 nonce:=make([]byte,12)
 copy(nonce,prefix)
 binary.BigEndian.PutUint32(nonce[8:],counter)
 return nonce
}

func encryptBackupPayload(source,destination string,master []byte)error{
 if len(master)!=32{return errors.New("invalid backup encryption key")}
 input,err:=os.Open(source)
 if err!=nil{return errors.New("unable to open backup payload for encryption")}
 defer input.Close()
 output,err:=os.OpenFile(destination,os.O_WRONLY|os.O_CREATE|os.O_EXCL,0600)
 if err!=nil{return errors.New("unable to create encrypted backup payload")}
 ok:=false
 defer func(){_ = output.Close();if !ok{_ = os.Remove(destination)}}()

 salt:=make([]byte,backupEncryptionSaltSize)
 noncePrefix:=make([]byte,backupEncryptionNoncePrefixSize)
 if _,err:=io.ReadFull(rand.Reader,salt);err!=nil{return errors.New("unable to generate backup encryption salt")}
 if _,err:=io.ReadFull(rand.Reader,noncePrefix);err!=nil{return errors.New("unable to generate backup encryption nonce")}
 key:=deriveBackupEncryptionKey(master,salt)
 block,err:=aes.NewCipher(key)
 if err!=nil{return errors.New("unable to initialize backup encryption")}
 aead,err:=cipher.NewGCM(block)
 if err!=nil{return errors.New("unable to initialize backup authentication")}
 if _,err:=output.Write(backupEncryptionMagic);err!=nil{return err}
 if _,err:=output.Write(salt);err!=nil{return err}
 if _,err:=output.Write(noncePrefix);err!=nil{return err}

 buffer:=make([]byte,backupEncryptionChunkSize)
 var counter uint32
 for{
  n,readErr:=io.ReadFull(input,buffer)
  if readErr!=nil&&readErr!=io.EOF&&readErr!=io.ErrUnexpectedEOF{return errors.New("unable to read backup payload for encryption")}
  if n>0{
   if counter==^uint32(0){return errors.New("backup payload is too large to encrypt")}
   plaintextLength:=uint32(n)
   sealed:=aead.Seal(nil,backupEncryptionNonce(noncePrefix,counter),buffer[:n],backupEncryptionAAD(salt,counter,plaintextLength))
   var length [4]byte
   binary.BigEndian.PutUint32(length[:],plaintextLength)
   if _,err:=output.Write(length[:]);err!=nil{return err}
   if _,err:=output.Write(sealed);err!=nil{return err}
   counter++
  }
  if readErr==io.EOF||readErr==io.ErrUnexpectedEOF{break}
 }
 final:=aead.Seal(nil,backupEncryptionNonce(noncePrefix,counter),nil,backupEncryptionAAD(salt,counter,0))
 var marker [4]byte
 if _,err:=output.Write(marker[:]);err!=nil{return err}
 if _,err:=output.Write(final);err!=nil{return err}
 if err:=output.Sync();err!=nil{return errors.New("unable to sync encrypted backup payload")}
 if err:=output.Close();err!=nil{return errors.New("unable to close encrypted backup payload")}
 ok=true
 return nil
}

func decryptBackupPayload(source,destination string,master []byte)error{
 if len(master)!=32{return errors.New("invalid backup encryption key")}
 input,err:=os.Open(source)
 if err!=nil{return errors.New("unable to open encrypted backup payload")}
 defer input.Close()
 header:=make([]byte,len(backupEncryptionMagic))
 if _,err:=io.ReadFull(input,header);err!=nil||string(header)!=string(backupEncryptionMagic){return errors.New("invalid encrypted backup header")}
 salt:=make([]byte,backupEncryptionSaltSize)
 noncePrefix:=make([]byte,backupEncryptionNoncePrefixSize)
 if _,err:=io.ReadFull(input,salt);err!=nil{return errors.New("invalid encrypted backup salt")}
 if _,err:=io.ReadFull(input,noncePrefix);err!=nil{return errors.New("invalid encrypted backup nonce")}
 key:=deriveBackupEncryptionKey(master,salt)
 block,err:=aes.NewCipher(key)
 if err!=nil{return errors.New("unable to initialize backup decryption")}
 aead,err:=cipher.NewGCM(block)
 if err!=nil{return errors.New("unable to initialize backup authentication")}
 output,err:=os.OpenFile(destination,os.O_WRONLY|os.O_CREATE|os.O_EXCL,0600)
 if err!=nil{return errors.New("unable to create decrypted backup payload")}
 ok:=false
 defer func(){_ = output.Close();if !ok{_ = os.Remove(destination)}}()

 var counter uint32
 total:=int64(0)
 for{
  var lengthBytes [4]byte
  if _,err:=io.ReadFull(input,lengthBytes[:]);err!=nil{return errors.New("encrypted backup payload is truncated")}
  plaintextLength:=binary.BigEndian.Uint32(lengthBytes[:])
  if plaintextLength>backupEncryptionChunkSize{return errors.New("encrypted backup chunk is too large")}
  ciphertextLength:=int(plaintextLength)+aead.Overhead()
  sealed:=make([]byte,ciphertextLength)
  if _,err:=io.ReadFull(input,sealed);err!=nil{return errors.New("encrypted backup payload is truncated")}
  plaintext,err:=aead.Open(nil,backupEncryptionNonce(noncePrefix,counter),sealed,backupEncryptionAAD(salt,counter,plaintextLength))
  if err!=nil{return errors.New("encrypted backup authentication failed")}
  if plaintextLength==0{
   var extra [1]byte
   n,readErr:=input.Read(extra[:])
   if n!=0||readErr!=io.EOF{return errors.New("encrypted backup contains trailing data")}
   break
  }
  total+=int64(len(plaintext))
  if total>backupMaxBytes(){return errors.New("decrypted backup exceeds configured size limit")}
  if _,err:=output.Write(plaintext);err!=nil{return errors.New("unable to write decrypted backup payload")}
  if counter==^uint32(0){return errors.New("encrypted backup contains too many chunks")}
  counter++
 }
 if err:=output.Sync();err!=nil{return errors.New("unable to sync decrypted backup payload")}
 if err:=output.Close();err!=nil{return errors.New("unable to close decrypted backup payload")}
 ok=true
 return nil
}

func backupPayloadEncrypted(path string)(bool,error){
 file,err:=os.Open(path)
 if err!=nil{return false,err}
 defer file.Close()
 header:=make([]byte,len(backupEncryptionMagic))
 n,err:=io.ReadFull(file,header)
 if err==io.EOF||err==io.ErrUnexpectedEOF{return false,nil}
 if err!=nil{return false,err}
 return n==len(header)&&string(header)==string(backupEncryptionMagic),nil
}
