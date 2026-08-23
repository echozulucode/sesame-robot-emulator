set pagination off
set confirm off
set print entry-values no
file C:/Projects/sesame-robot-emulator/tools/arduino-data/scratch/qemu-dio/out/sesame-firmware-main.ino.elf
target remote 127.0.0.1:3333
break sesame-firmware-main.ino:652
commands
  silent
  printf "@LADDER STEP01 line=652 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:653
commands
  silent
  printf "@LADDER STEP02 line=653 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:656
commands
  silent
  printf "@LADDER STEP03 line=656 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:659
commands
  silent
  printf "@LADDER STEP04 line=659 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:664
commands
  silent
  printf "@LADDER STEP05 line=664 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:674
commands
  silent
  printf "@LADDER STEP06 line=674 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:677
commands
  silent
  printf "@LADDER STEP07 line=677 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:688
commands
  silent
  printf "@LADDER STEP08 line=688 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:689
commands
  silent
  printf "@LADDER STEP09 line=689 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:695
commands
  silent
  printf "@LADDER STEP10 line=695 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:703
commands
  silent
  printf "@LADDER STEP11 line=703 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:709
commands
  silent
  printf "@LADDER STEP12 line=709 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:712
commands
  silent
  printf "@LADDER STEP13 line=712 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:729
commands
  silent
  printf "@LADDER STEP14 line=729 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:731
commands
  silent
  printf "@LADDER STEP15 line=731 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:734
commands
  silent
  printf "@LADDER STEP16 line=734 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:739
commands
  silent
  printf "@LADDER STEP17 line=739 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:744
commands
  silent
  printf "@LADDER STEP18 line=744 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:747
commands
  silent
  printf "@LADDER STEP19 line=747 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:749
commands
  silent
  printf "@LADDER STEP20 line=749 pc=0x%x\n", $pc
  continue
end
break sesame-firmware-main.ino:661
commands
  silent
  printf "@LADDER OLED-HARDFAIL line=661 pc=0x%x\n", $pc
  continue
end
printf "@LADDER begin\n"
continue
printf "@LADDER stopped\n"
info registers pc ps
bt
detach
quit
