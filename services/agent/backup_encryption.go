package main

import (
 "crypto/aes"
 "crypto/cipher"
 "crypto/hmac"
 "crypto/rand"
 "crypto/sha256"
 "encoding/base64"
 "encoding/binary"
 "encoding/hex"
 "errors"
 "fmt"
 "io"
 "os"
 "strconv"
 "strings"
)

var backupEncryptionMagicV1=[]byte("CDBKENC1")
var backupEncryptionMagicV2=[]byte("CDBKENC2")
const backupEncryptionChunkSize=1024*1024
const backupEncryptionSaltSize=16
const backupEncryptionNoncePrefixSize=8
const backupEncryptionAlgorithm="AES-256-GCM-CHUNKED"

type backupEncryptionHeader struct{
 FormatVersion uint32
 KeyVersion uint32
}

type backupEncryptionMetadata struct{
 Algorithm string `json:"algorithm"`
 KeyVersion uint32 `json:"keyVersion"`
 CipherSHA256 string `json:"cipherSha256"`
}

func backupEncryptionKeyVersion()(uint32,error){
 raw:=strings.TrimSpace(os.Getenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY_VERSION"))
 if raw==""{return 1,nil}
 value,err:=strconv.ParseUint(raw,10,32)
 if err!=nil||value==0{return 0,errors.New("CLOUDDECK_BACKUP_ENCRYPTION_KEY_VERSION must be a positive integer")}
 return uint32(value),nil
}

func decodeBackupEncryptionKey(raw string)([]byte,bool,error){
 raw=strings.TrimSpace(raw)
 if raw==""{return nil,false,nil}
 key,err:=base64.StdEncoding.DecodeString(raw)
 if err!=nil||len(key)!=32{return nil,false,errors.New("backup encryption key must be base64 for exactly 32 bytes")}
 return key,true,nil
}

func backupEncryptionKey()([]byte,bool,error){
 version,err:=backupEncryptionKeyVersion()
 if err!=nil{return nil,false,err}
 return backupEncryptionKeyForVersion(version)
}

func backupEncryptionKeyForVersion(version uint32)([]byte,bool,error){
 if version==0{return nil,false,errors.New("invalid backup encryption key version")}
 activeVersion,err:=backupEncryptionKeyVersion()
 if err!=nil{return nil,false,err}
 name:="CLOUDDECK_BACKUP_ENCRYPTION_KEY"
 if version!=activeVersion{name+="_V"+strconv.FormatUint(uint64(version),10)}
 return decodeBackupEncryptionKey(os.Getenv(name))
}

func encryptedBackupMaxBytes()int64{
 plain:=backupMaxBytes()
 chunks:=plain/int64(backupEncryptionChunkSize)+2
 return plain+chunks*32+4096
}

func backupFileSHA256(path string)(string,error){
 file,err:=os.Open(path)
 if err!=nil{return "",err}
 defer file.Close()
 info,err:=file.Stat()
 if err!=nil{return "",err}
 limit:=encryptedBackupMaxBytes()
 if info.Size()<0||info.Size()>limit{return "",errors.New("backup file exceeds configured size limit")}
 hash:=sha256.New()
 copied,err:=io.Copy(hash,io.LimitReader(file,limit+1))
 if err!=nil{return "",err}
 if copied>limit{return "",errors.New("backup file exceeds configured size limit")}
 return hex.EncodeToString(hash.Sum(nil)),nil
}

func deriveBackupEncryptionKey(master,salt []byte,formatVersion uint32)[]byte{
 context:="clouddeck-backup-v1"
 if formatVersion==2{context="clouddeck-backup-v2"}
 mac:=hmac.New(sha256.New,master)
 _,_=mac.Write([]byte(context))
 _,_=mac.Write(salt)
 return mac.Sum(nil)
}

func backupEncryptionAAD(magic,salt []byte,keyVersion,counter,plaintextLength uint32)[]byte{
 aad:=make([]byte,0,len(magic)+len(salt)+12)
 aad=append(aad,magic...)
 if string(magic)==string(backupEncryptionMagicV2){
  var version [4]byte
  binary.BigEndian.PutUint32(version[:],keyVersion)
  aad=append(aad,version[:]...)
 }
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
 version,err:=backupEncryptionKeyVersion()
 if err!=nil{return err}
 return encryptBackupPayloadVersion(source,destination,master,2,version)
}

// encryptBackupPayloadVersion retains a format-1 writer for compatibility tests;
// all new backup operations use authenticated format 2 with an explicit key version.
func encryptBackupPayloadVersion(source,destination string,master []byte,formatVersion,keyVersion uint32)error{
 if len(master)!=32{return errors.New("invalid backup encryption key")}
 if formatVersion!=1&&formatVersion!=2{return errors.New("unsupported backup encryption format")}
 if formatVersion==1{keyVersion=1}
 if keyVersion==0{return errors.New("invalid backup encryption key version")}
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
 key:=deriveBackupEncryptionKey(master,salt,formatVersion)
 block,err:=aes.NewCipher(key)
 if err!=nil{return errors.New("unable to initialize backup encryption")}
 aead,err:=cipher.NewGCM(block)
 if err!=nil{return errors.New("unable to initialize backup authentication")}
 magic:=backupEncryptionMagicV2
 if formatVersion==1{magic=backupEncryptionMagicV1}
 if _,err:=output.Write(magic);err!=nil{return err}
 if formatVersion==2{
  var version [4]byte
  binary.BigEndian.PutUint32(version[:],keyVersion)
  if _,err:=output.Write(version[:]);err!=nil{return err}
 }
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
   sealed:=aead.Seal(nil,backupEncryptionNonce(noncePrefix,counter),buffer[:n],backupEncryptionAAD(magic,salt,keyVersion,counter,plaintextLength))
   var length [4]byte
   binary.BigEndian.PutUint32(length[:],plaintextLength)
   if _,err:=output.Write(length[:]);err!=nil{return err}
   if _,err:=output.Write(sealed);err!=nil{return err}
   counter++
  }
  if readErr==io.EOF||readErr==io.ErrUnexpectedEOF{break}
 }
 final:=aead.Seal(nil,backupEncryptionNonce(noncePrefix,counter),nil,backupEncryptionAAD(magic,salt,keyVersion,counter,0))
 var marker [4]byte
 if _,err:=output.Write(marker[:]);err!=nil{return err}
 if _,err:=output.Write(final);err!=nil{return err}
 if err:=output.Sync();err!=nil{return errors.New("unable to sync encrypted backup payload")}
 if err:=output.Close();err!=nil{return errors.New("unable to close encrypted backup payload")}
 ok=true
 return nil
}

func readBackupEncryptionHeader(path string)(backupEncryptionHeader,bool,error){
 var header backupEncryptionHeader
 file,err:=os.Open(path)
 if err!=nil{return header,false,err}
 defer file.Close()
 magic:=make([]byte,len(backupEncryptionMagicV1))
 n,readErr:=io.ReadFull(file,magic)
 if readErr==io.EOF||readErr==io.ErrUnexpectedEOF{return header,false,nil}
 if readErr!=nil{return header,false,readErr}
 if n!=len(magic){return header,false,nil}
 switch string(magic){
 case string(backupEncryptionMagicV1):
  header.FormatVersion=1
  header.KeyVersion=1
 case string(backupEncryptionMagicV2):
  header.FormatVersion=2
  var version [4]byte
  if _,err:=io.ReadFull(file,version[:]);err!=nil{return header,false,errors.New("encrypted backup key-version header is truncated")}
  header.KeyVersion=binary.BigEndian.Uint32(version[:])
  if header.KeyVersion==0{return header,false,errors.New("encrypted backup key version is invalid")}
 default:
  return header,false,nil
 }
 salt:=make([]byte,backupEncryptionSaltSize)
 nonce:=make([]byte,backupEncryptionNoncePrefixSize)
 if _,err:=io.ReadFull(file,salt);err!=nil{return header,false,errors.New("encrypted backup salt is truncated")}
 if _,err:=io.ReadFull(file,nonce);err!=nil{return header,false,errors.New("encrypted backup nonce is truncated")}
 return header,true,nil
}

func decryptBackupPayload(source,destination string,master []byte)error{
 if len(master)!=32{return errors.New("invalid backup encryption key")}
 header,encrypted,err:=readBackupEncryptionHeader(source)
 if err!=nil{return err}
 if !encrypted{return errors.New("invalid encrypted backup header")}
 input,err:=os.Open(source)
 if err!=nil{return errors.New("unable to open encrypted backup payload")}
 defer input.Close()
 magic:=make([]byte,len(backupEncryptionMagicV1))
 if _,err:=io.ReadFull(input,magic);err!=nil{return errors.New("invalid encrypted backup header")}
 if header.FormatVersion==2{
  var version [4]byte
  if _,err:=io.ReadFull(input,version[:]);err!=nil{return errors.New("encrypted backup key-version header is truncated")}
 }
 salt:=make([]byte,backupEncryptionSaltSize)
 noncePrefix:=make([]byte,backupEncryptionNoncePrefixSize)
 if _,err:=io.ReadFull(input,salt);err!=nil{return errors.New("invalid encrypted backup salt")}
 if _,err:=io.ReadFull(input,noncePrefix);err!=nil{return errors.New("invalid encrypted backup nonce")}
 key:=deriveBackupEncryptionKey(master,salt,header.FormatVersion)
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
  plaintext,err:=aead.Open(nil,backupEncryptionNonce(noncePrefix,counter),sealed,backupEncryptionAAD(magic,salt,header.KeyVersion,counter,plaintextLength))
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

func decryptBackupPayloadWithConfiguredKey(source,destination string)(backupEncryptionHeader,error){
 header,encrypted,err:=readBackupEncryptionHeader(source)
 if err!=nil{return header,err}
 if !encrypted{return header,errors.New("backup payload is not encrypted")}
 key,configured,err:=backupEncryptionKeyForVersion(header.KeyVersion)
 if err!=nil{return header,err}
 if !configured{return header,fmt.Errorf("encrypted backup requires key version %d in the agent keyring",header.KeyVersion)}
 if err:=decryptBackupPayload(source,destination,key);err!=nil{return header,err}
 return header,nil
}

func backupPayloadEncrypted(path string)(bool,error){
 _,encrypted,err:=readBackupEncryptionHeader(path)
 return encrypted,err
}
