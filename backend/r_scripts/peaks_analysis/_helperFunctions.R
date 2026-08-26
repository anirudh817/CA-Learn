
#__helperFunctions.R
#v1.5: 3/15/2022; Kiran Pandey {kiranpandeyphd@gmail.com}
#===============================================================================#
#DESCRIPTION: This is the helper function file to abstract several function calls.
# - Updated Anova with Try-Catch

library(lme4)
library(lmerTest)
library(multcomp)
library(nnet)
library(MASS)
library(car)
library(emmeans)
library(FSA)
library(dunn.test)


#===============================================================================
#1.DataETL helper functions
#===============================================================================

#A. helper_MatchDataAndTraits: Matches the sample information in the data and trait files

#A. Match Data and TRaits - helps ensure congruency between proteins/peptides file and traits file after various manipulations to data or traits files
helper_MatchDataAndTraits<-function(proteinDatFile, traitsMetaDataFile){
  outputResults <-list()
  
  #--->B.I. Match colnames from protein abundance data files to meta traits rownames. If not a perfect match, remove the colums from cleanDat/protein abundance data that do not have a match onto traits meta data
  if (length(intersect(colnames(proteinDatFile), rownames(traitsMetaDataFile))) < length(colnames(proteinDatFile))) {
    tmp.MissingSampleTraits     <- sort(setdiff(colnames(proteinDatFile), na.omit(rownames(traitsMetaDataFile)[na.omit(match(colnames(proteinDatFile), rownames(traitsMetaDataFile)))])))
    cat(paste0("WARNING: Missing traits for the following sample(s) in provided abundance data:\n", paste(tmp.MissingSampleTraits, collapse = ", "), "\n" ))
    cat("These samples have been removed.\n") 
    proteinDatFile              <- proteinDatFile[, -match(tmp.MissingSampleTraits, colnames(proteinDatFile))]
  }
  
  #--->B.II Check for and remove extra traits not in abundance data
  if (length(intersect(rownames(traitsMetaDataFile), colnames(proteinDatFile))) < length(rownames(traitsMetaDataFile))) {
    tmp.ExtraSampleTraits       <- sort(setdiff(rownames(traitsMetaDataFile), na.omit(colnames(proteinDatFile)[na.omit(match(rownames(traitsMetaDataFile), colnames(proteinDatFile)))])))
    cat(paste0("WARNING: Sample(s) in traits not found in provided abundance data:\n", paste(tmp.ExtraSampleTraits, collapse = ", "),"\n"))
    cat("These samples have been removed from traits.\n") 
    traitsMetaDataFile          <- traitsMetaDataFile[-match(tmp.ExtraSampleTraits, rownames(traitsMetaDataFile)), ]
  }
  
  #--->B.III Ensure the batches are samples are ordered "chronologically" and the batch-sample handles are defined
  traitsMetaDataFile            <- traitsMetaDataFile[order(traitsMetaDataFile$STD_PRIMARYKEY), ]
  proteinDatFile                <- proteinDatFile[, order(colnames(proteinDatFile))]
  
  #--->RETURN OUTPUT
  outputResults  <- list(proteinDatFile, traitsMetaDataFile)
  return(outputResults)
}
#...............................................................................



#===============================================================================
#2.DataETL helper functions
#===============================================================================

#A. Ignore samples & updated bad values (e.g., negative values, inf etc.)

ignoreSamples    <- function(cleanDat, samplesToIgnore) {
  if (length(na.omit(match(samplesToIgnore, rownames(cleanDat)))) == length(samplesToIgnore) & length(samplesToIgnore) > 0) {
    cleanDat <- cleanDat[-match(samplesToIgnore, rownames(cleanDat)),]
  } else { cat("")
  } # "no rows removed.\n"); }
  return(cleanDat)
}

removeSamples_Missingness <- function(cleanDat, threshold){
  LThalfSamples                     <- ceiling(length(colnames(cleanDat))*threshold)-1
  print(LThalfSamples)
  removedRownames1                  <- rownames(cleanDat[which(rowSums(as.matrix(is.na(cleanDat))) > LThalfSamples),]) # list rows to be removed
  if (length(na.omit(match(removedRownames1, rownames(cleanDat)))) == length(removedRownames1) & length(removedRownames1) > 0) {
    cleanDat <- cleanDat[-match(removedRownames1, rownames(cleanDat)),]
  } else { cat("")
  } # "no rows removed.\n"); }
  dim(cleanDat)
  return(cleanDat)
}
#...............................................................................



#===============================================================================
#6.Analysis_Summary & Descriptive Stats helper functions
#===============================================================================

#-----------------
# Helper ANOVA
# Helper GLMMRM
#-----------------

helper_ANOVA        <- function(tmp.cleanDat, tmp.Dx_Group, p_adj_Mthd, level, csfModuleFlag){
  #CURRENT CAPABILITY
  # - ONE WAY ANOVA Using aov/TukeyHSD in case contrast includes two variables only
  # - ONE WAY Multi-contrast Anova using aov/TukeyHSD
  #** Repeated Measures Anova
  #** Mixed Effects Modeling (Check for model fit - Normal vs. others; Fixed and Confounding variable modeling)
  
  
  if(FALSE){
    tmp.cleanDat  = cleanDat.input
    tmp.Dx_Group  = drugStatus
    
  }
  
  #PREP DATA
  #-----------------------------------------------------------------------------
  load(paste0(global.inputDirectory,"MEGA488_forORA.RData"))
  MEGAsymbols                  <- as.data.frame(do.call("rbind",strsplit(names(netMEGA$colors),"[|]")))[,1]
  this.modOntol                <-read.csv(file=paste0(global.inputDirectory,"_MEGA488_modDefinitions.csv"),header=FALSE); colnames(this.modOntol)<-c("color","Name")
  
  #################
  if (csfModuleFlag){
    csfModule                    <- as.data.frame(read.csv(paste0(global.inputDirectory,"CSF_Modules_10.10.2023.csv"))); colnames(csfModule)<-c("GENE_PROTEIN","Symbols", "Proteins", "Color", "Modules")
  }
  #################
  
  p_adj_Mthd                   <- p_adj_Mthd
  #SETUP UP DATA 
  #-----------------------------------------------------------------------------
  tmp.cleanDat                 <- as.data.frame(tmp.cleanDat)
  tmp.Dx_Group                 <- tmp.Dx_Group
  offset                       <- 2
  datMatrix                    <- as.data.frame(as.matrix(cbind(colnames(tmp.cleanDat), tmp.Dx_Group, t(tmp.cleanDat)))); 
  colnames(datMatrix)[1:offset] <- c("channels","Dx_Group"); 
  datMatrix                    <- datMatrix[which(!is.na(datMatrix$Dx_Group)),]
  
  #SETUP MODEL
  #-----------------------------------------------------------------------------
  ANOVA_Results                <- tuk_Results           <- list()
  resultAnovaStat              <- data.frame()
  
  for (i in (offset+1):ncol(datMatrix)){
    #One-way Anova
    tmp.data                   <- as.data.frame(as.numeric(datMatrix[,i]));
    if (is.null(level))        level=rev(names(table(tmp.Dx_Group)))
    Dx_Group                   <- factor(datMatrix$Dx_Group, levels = level)
    print(i)
    #print(rownames(cleanDat.input)[i])
    #***********************ANOVA***********************************************
    if(TRUE){
      aov                       <- aov(unlist(tmp.data)~Dx_Group, data=tmp.data)
      summary(aov)    
      # anova_out                <- anova(aov)                                   #Modified 3.22 (see below)
      # tuk_out                  <- TukeyHSD(aov)                                #Modified 3.22 (see below)
      #Changes below - added tryCatch to error. F stat & effect size set to 0 & P-values set to 1 in case of error
      anova_out                 <- tryCatch(anova(aov(unlist(tmp.data)~Dx_Group, data=tmp.data)), 
                                            error=function(e) (ANOVA_Results[[i-offset-1]]*0+1))
      tuk_out                    <- tryCatch(as.data.frame(TukeyHSD(aov(unlist(tmp.data)~Dx_Group, data=tmp.data))[[1]]), 
                                             error=function(e){
                                               tuk_out    = tuk_Results[i-offset-1][[1]];
                                               for (indx in 1:tuk_indx){
                                                 tuk_out[indx,1:3]= 0;
                                                 tuk_out[indx,4]  = 1;
                                               }
                                               return(tuk_out)
                                             })
    }
    # anova_out                   <- list(anova_out)
    tuk_out                     <- list(tuk_out)
    ANOVA_Results[[i-offset]]   <- anova_out
    tuk_Results[[i-offset]]     <- tuk_out
    
    #Two vs. more than two contrasts
    if (i==(offset+1)){ 
      #Set Column Headers
      tuk_indx                 <- dim(tuk_out[[1]])[1]                          
      headerOutput             <- c(names(anova_out)[4], names(anova_out)[5])
      for (indx in 1:tuk_indx){
        headerOutput         <- c(headerOutput, colnames(tuk_out[[1]])[4], rownames(tuk_out[[1]])[indx]) 
      }
    }
    #Add data per contrast     
    resultAnovaStat_iter       <- c(anova_out$`F value`[1], anova_out$`Pr(>F)`[1])#   , tuk_out$Dx_Group[c(4,1)])
    for (indx in 1:tuk_indx){
      resultAnovaStat_iter    <-  c(resultAnovaStat_iter, tuk_out[[1]][indx,4], tuk_out[[1]][indx, 1]) 
    }
    resultAnovaStat            <- rbind(resultAnovaStat, resultAnovaStat_iter)
  }
  
  colnames(resultAnovaStat)    <- headerOutput; 
  rownames(resultAnovaStat)    <- rownames(tmp.cleanDat)
  thisCleanDat.symbols         <- as.data.frame(do.call("rbind",strsplit(rownames(tmp.cleanDat),";|]")))[,1]
  thisCleanDat.symbols         <- as.data.frame(do.call("rbind",strsplit(thisCleanDat.symbols,"[|]")))[,1]
  
  thisCleanDat.MEGAcolors      <- netMEGA$colors[match(thisCleanDat.symbols,MEGAsymbols)]
  thisCleanDat.MEGAcolors[which(thisCleanDat.symbols=="0")]<-"grey40"
  thisCleanDat.MEGAcolors[is.na(thisCleanDat.MEGAcolors)]<-"grey40"
  
  resultAnovaStat$NETcolors    <- thisCleanDat.MEGAcolors
  resultAnovaStat$Modules      <- this.modOntol$Name[match(resultAnovaStat$NETcolors,this.modOntol$color)]
  #############################
  if (csfModuleFlag){
    resultAnovaStat$CSFModules   <- csfModule$Modules[match(thisCleanDat.symbols, csfModule$Symbols)]
    resultAnovaStat$CSFcolors    <- csfModule$Color[match(thisCleanDat.symbols, csfModule$Symbols)]
  }
  ############################
  resultAnovaStat$P_BH         <- as.vector(p.adjust(resultAnovaStat[,2], method = "BH"))
  resultAnovaStat$P_ADJ        <- as.vector(p.adjust(resultAnovaStat[,2], method = p_adj_Mthd))
  
  
  
  
  return(list(anovaResults = resultAnovaStat[order(resultAnovaStat$P_ADJ),], anovaParams = ANOVA_Results, tukParams = tuk_Results))
}

helper_ANOVA_GLMMRM <- function(tmp.cleanDat, tmp.Dx_Group, p_adj_Mthd, level){
  #** Repeated Measures Anova | Mixed Effects Modeling (Check for model fit - Normal vs. others; Fixed and Confounding variable modeling)
  
  if(FALSE){
    tmp.cleanDat  =  cleanDat.input
    tmp.Dx_Group  =  drugStatus
    level         =  c("Placebo", "Drug")
  }
  
  #PREP DATA
  #------------------------------------
  load(paste0(global.inputDirectory,"MEGA488_forORA.RData"))
  MEGAsymbols                  <- as.data.frame(do.call("rbind",strsplit(names(netMEGA$colors),"[|]")))[,1]
  this.modOntol    <-read.csv(file=paste0(global.inputDirectory,"_MEGA488_modDefinitions.csv"),header=FALSE); colnames(this.modOntol)<-c("color","Name")
  p_adj_Mthd                   <- p_adj_Mthd
  #SETUP UP DATA/PARAMETERS 
  #-----------------------------------
  offset                       <- 5
  tmp.traits                   <- tmp.cleanDat[,c(1:offset)]
  ANOVA_Results                <- lsmeans_Results           <- list()
  m.lme_out                    <- anova_lme_out             <- lme.effect <-     data.frame()
  n=ncol(tmp.cleanDat)
  #SETUP MODEL
  #-----------------------------------
  for (i in (offset+1):n){
    if(i%%100==0){print(i)}
    #PROCESS & PREP DATA
    tmp.y                      <- as.numeric(tmp.cleanDat[,i]); tmp.y[is.infinite(tmp.y)]<-0;  
    tmp.data                   <- as.data.frame(cbind(tmp.traits, tmp.y)); colnames(tmp.data)=c(colnames(tmp.traits), "y")
    m.lme                      <- lmer(y~Treatment*Group +(1|Group), data=tmp.data);   summary(m.lme)
    anova_out                  <- anova(m.lme)  
    m.lme_effect               <- emmeans(m.lme, ~Treatment*Group)
    m.lme_out                  <- data.frame(contrast(m.lme_effect, "consec", simple="Group", combine=FALSE, adjust="none"))
    #GLMMRM RESULTS-----------------------------------
    tmp.anova_out              <- NULL
    for(ind in 1:3){tmp.anova_out   <- cbind(tmp.anova_out, rownames(anova_out)[ind], anova_out[,"F value"][ind], anova_out[,"Pr(>F)"][ind]) }; 
    ANOVA_Results[[i-offset]]  <- anova_out
    anova_lme_out              <- rbind(anova_lme_out, tmp.anova_out)
    if (i==n){print(i); colnames(anova_lme_out)<- c(rownames(anova_out)[1],"F value", "Pr(>F)", rownames(anova_out)[2],"F value", "Pr(>F)", rownames(anova_out)[3],"F value", "Pr(>F)" )}
    #EFFECT SIZE-------------------------------------
    lsmeans_Results[[i-offset]]<- m.lme_out
    tmp.effect_out             <- NULL
    if (dim(m.lme_out)[1]>2){
      tmp.effect_out             <- cbind(paste0(m.lme_out[,"Treatment"][3],"-",m.lme_out[,"Treatment"][2]),m.lme_out[,"estimate"][3]-m.lme_out[,"estimate"][2] ,
                                          paste0(m.lme_out[,"Treatment"][3],"-",m.lme_out[,"Treatment"][1]), m.lme_out[,"estimate"][3]-m.lme_out[,"estimate"][1],
                                          paste0(m.lme_out[,"Treatment"][2],"-",m.lme_out[,"Treatment"][1]),m.lme_out[,"estimate"][2]-m.lme_out[,"estimate"][1] )
    }else{
      tmp.effect_out             <- cbind(paste0("Treatment:",m.lme_out[,"Treatment"][2],"-",m.lme_out[,"Treatment"][1]),m.lme_out[,"estimate"][2]-m.lme_out[,"estimate"][1])
    }
    #CREATE OUTPUT-----------------------------------  
    lme.effect                 <- rbind(lme.effect, tmp.effect_out)
    if (i==n){
      if (dim(m.lme_out)[1]>2){
        colnames(lme.effect)<- c(lme.effect[1,1],"Diff", lme.effect[1,3],"Diff", lme.effect[1,5],"Diff")
      }else{
        colnames(lme.effect)<- c(lme.effect[1,1],"Drug-Placebo")
      }    
    }  
    #print(colnames(tmp.cleanDat)[i])
  }  
  resultAnovaStat              <- cbind(anova_lme_out, lme.effect)
  rownames(resultAnovaStat)    <- colnames(tmp.cleanDat)[c((offset+1)):n]
  resultAnovaStat$F_Treat_v_Group<- resultAnovaStat[, c(8)]
  resultAnovaStat$P_ADJ        <- resultAnovaStat[,c(9)]
  resultAnovaStat$P_ADJ        <- as.vector(p.adjust(resultAnovaStat$P_ADJ, method = p_adj_Mthd))
  thisCleanDat.symbols         <- as.data.frame(do.call("rbind",strsplit(colnames(tmp.cleanDat),";|]")))[,1]
  thisCleanDat.symbols         <- as.data.frame(do.call("rbind",strsplit(thisCleanDat.symbols,"[|]")))[,1]
  thisCleanDat.MEGAcolors      <- netMEGA$colors[match(thisCleanDat.symbols,MEGAsymbols)]
  thisCleanDat.MEGAcolors[which(thisCleanDat.symbols=="0")]<-"grey40"
  thisCleanDat.MEGAcolors[is.na(thisCleanDat.MEGAcolors)]<-"grey40"
  resultAnovaStat$NETcolors    <- thisCleanDat.MEGAcolors[(offset+1):n]
  
  return(list(anovaResults = resultAnovaStat[order(resultAnovaStat$P_ADJ),], anovaParams = ANOVA_Results, emmParams = lsmeans_Results))
}

helper_ANOVA_ANCOVA <- function(tmp.cleanDat_Pre, tmp.cleanDat_Post, tmp.Dx_Group, p_adj_Mthd, level){
  #   #CURRENT CAPABILITY
  #   # - ONE WAY ANOVA Using aov/TukeyHSD in case contrast includes two variables only
  #   # - ONE WAY Multi-contrast Anova using aov/TukeyHSD
  #   #** Repeated Measures Anova
  #   #** Mixed Effects Modeling (Check for model fit - Normal vs. others; Fixed and Confounding variable modeling)
  #  
  #    if(FALSE){
  #     tmp.cleanDat_Pre  = cleanDat.Diff.Pre
  #     tmp.cleanDat_Post = cleanDat.Diff.Post
  #     tmp.Dx_Group      = cleanDat.Diff.Pre$Treatment; 
  #     tmp.Dx_Group      = ifelse(tmp.Dx_Group=="Placebo", "Placebo", "Drug")
  #   }
  #   
  #   
  #   #PREP DATA
  #   #-----------------------------------------------------------------------------
  #   load(paste0(global.inputDirectory,"MEGA488_forORA.RData"))
  #   MEGAsymbols                  <- as.data.frame(do.call("rbind",strsplit(names(netMEGA$colors),"[|]")))[,1]
  #   this.modOntol                <-read.csv(file=paste0(global.inputDirectory,"_MEGA488_modDefinitions.csv"),header=FALSE); colnames(this.modOntol)<-c("color","Name")
  #   p_adj_Mthd                   <- p_adj_Mthd
  #   #SETUP UP DATA 
  #   #-----------------------------------------------------------------------------
  #   
  #  
  #   #SETUP MODEL
  #   #-----------------------------------------------------------------------------
  #   ANOVA_Results                <- tuk_Results           <- list()
  #   resultAnovaStat              <- data.frame()
  #   
  #   for (i in (offset):ncol(datMatrix)){
  #     #One-way Anova
  #     pre                        <-as.numeric(unlist(tmp.cleanDat_Pre[,i]))
  #     post                       <-as.numeric(unlist(tmp.cleanDat_Post[, i]))
  #     tmp.data                   <- as.data.frame(cbind(tmp.Dx_Group, pre, post));
  #     colnames(tmp.data)         <- c("Dx_Group", "Pre", "Post")
  #     if (is.null(level))        level=rev(names(table(tmp.Dx_Group)))
  #     tmp.data$Dx_Group          <- factor(tmp.data$Dx_Group, levels = level)
  #     #print(rownames(cleanDat.input)[i])
  #     #***********************ANOVA***********************************************
  #     #*https://github.com/seanwithafada/Effect-size-of-Pairwise-Comparisons-using-emmeans/blob/main/Effect%20size%20of%20Pairwise%20Comparisons%20using%20emmeans.txt
  #     if(TRUE){
  #       aov                       <- aov(post ~ pre + Dx_Group, data=tmp.data)
  #       summary(aov)
  #       anova_out                 <- anova(aov)
  #       
  #       library(effectsize)
  #       eta_squared(aov,ci=0.95,alternative="two.sided")
  #       
  #       
  #       
  #       #-----------OPTION 1--------------------------
  #       library(multcomp)
  #       postHocs     <- glht(aov, linfct = mcp(Dx_Group = "Tukey"))
  #       tuk_out                   <- summary(postHocs) 
  #       #-----------OPTION 2--------------------------
  #       aov_emmeans <- emmeans(aov, "Dx_Group")
  #       pairs(aov_emmeans)
  #       (eff1<-eff_size(aov_emmeans, sigma = sigma(result), edf = df.residual(result)))
  #       
  #       # anova_out                <- anova(aov)                                   #Modified 3.22 (see below)
  #       # tuk_out                  <- TukeyHSD(aov)                                #Modified 3.22 (see below)
  #       #Changes below - added tryCatch to error. F stat & effect size set to 0 & P-values set to 1 in case of error
  #       # anova_out                 <- tryCatch(anova(aov(post ~ pre + Dx_Group, data=tmp.data)), 
  #       #                                       error=function(e) (ANOVA_Results[[i-offset-1]]*0+1))
  #       # tuk_out                   <- tryCatch(as.data.frame(summary(glht(aov, linfct = mcp(Dx_Group = "Tukey")))$test), 
  #                                              # error=function(e){
  #                                              #   tuk_out    = tuk_Results[i-offset-1][[1]];
  #                                              #   for (indx in 1:tuk_indx){
  #                                              #     tuk_out[indx,1:3]= 0;
  #                                              #     tuk_out[indx,4]  = 1;
  #                                              #   }
  #                                              #   return(tuk_out)
  #                                              # })
  #     
  #     # anova_out                   <- list(anova_out)
  #     tuk_out                     <- list(tuk_out)
  #     ANOVA_Results[[i-offset]]   <- anova_out
  #     tuk_Results[[i-offset]]     <- tuk_out
  #     
  #     #Two vs. more than two contrasts
  #     if (i==(offset+1)){ 
  #       #Set Column Headers
  #       tuk_indx                 <- dim(tuk_out[[1]])[1]                          
  #       headerOutput             <- c(names(anova_out)[4], names(anova_out)[5])
  #       for (indx in 1:tuk_indx){
  #         headerOutput         <- c(headerOutput, colnames(tuk_out[[1]])[4], rownames(tuk_out[[1]])[indx]) 
  #       }
  #     }
  #     #Add data per contrast     
  #     resultAnovaStat_iter       <- c(anova_out$`F value`[1], anova_out$`Pr(>F)`[1])#   , tuk_out$Dx_Group[c(4,1)])
  #     for (indx in 1:tuk_indx){
  #       resultAnovaStat_iter    <-  c(resultAnovaStat_iter, tuk_out[[1]][indx,4], tuk_out[[1]][indx, 1]) 
  #     }
  #     resultAnovaStat            <- rbind(resultAnovaStat, resultAnovaStat_iter)
  #   }
  #   
  #   colnames(resultAnovaStat)    <- headerOutput; 
  #   rownames(resultAnovaStat)    <- rownames(tmp.cleanDat)
  #   thisCleanDat.symbols         <- as.data.frame(do.call("rbind",strsplit(rownames(tmp.cleanDat),";|]")))[,1]
  #   thisCleanDat.symbols         <- as.data.frame(do.call("rbind",strsplit(thisCleanDat.symbols,"[|]")))[,1]
  #   thisCleanDat.MEGAcolors      <- netMEGA$colors[match(thisCleanDat.symbols,MEGAsymbols)]
  #   thisCleanDat.MEGAcolors[which(thisCleanDat.symbols=="0")]<-"grey40"
  #   thisCleanDat.MEGAcolors[is.na(thisCleanDat.MEGAcolors)]<-"grey40"
  #   
  #   resultAnovaStat$NETcolors    <- thisCleanDat.MEGAcolors
  #   resultAnovaStat$Modules      <- this.modOntol$Name[match(resultAnovaStat$NETcolors,this.modOntol$color)]
  #   resultAnovaStat$P_BH         <- as.vector(p.adjust(resultAnovaStat[,2], method = "BH"))
  #   resultAnovaStat$P_ADJ        <- as.vector(p.adjust(resultAnovaStat[,2], method = p_adj_Mthd))
  #   return(list(anovaResults = resultAnovaStat[order(resultAnovaStat$P_ADJ),], anovaParams = ANOVA_Results, tukParams = tuk_Results))
  #   
}

helper_ANOVA_temp   <- function(tmp.cleanDat, tmp.Dx_Group, p_adj_Mthd, level, csfModuleFlag){
  #CURRENT CAPABILITY
  # - ONE WAY ANOVA Using aov/TukeyHSD in case contrast includes two variables only
  # - ONE WAY Multi-contrast Anova using aov/TukeyHSD
  #** Repeated Measures Anova
  #** Mixed Effects Modeling (Check for model fit - Normal vs. others; Fixed and Confounding variable modeling)
  
  
  if(FALSE){
    tmp.cleanDat  = cleanDat.input
    tmp.Dx_Group  = drugStatus
    
  }
  
  #PREP DATA
  #-----------------------------------------------------------------------------
  load(paste0(global.inputDirectory,"MEGA488_forORA.RData"))
  MEGAsymbols                  <- as.data.frame(do.call("rbind",strsplit(names(netMEGA$colors),"[|]")))[,1]
  this.modOntol                <-read.csv(file=paste0(global.inputDirectory,"_MEGA488_modDefinitions.csv"),header=FALSE); colnames(this.modOntol)<-c("color","Name")
  
  #################
  if (csfModuleFlag){
    csfModule                    <- as.data.frame(read.csv(paste0(global.inputDirectory,"CSF_Modules_10.10.2023.csv"))); colnames(csfModule)<-c("GENE_PROTEIN","Symbols", "Proteins", "Color", "Modules")
  }
  #################
  
  p_adj_Mthd                   <- p_adj_Mthd
  #SETUP UP DATA 
  #-----------------------------------------------------------------------------
  tmp.cleanDat                 <- as.data.frame(tmp.cleanDat)
  tmp.Dx_Group                 <- tmp.Dx_Group
  offset                       <- 2
  datMatrix                    <- as.data.frame(as.matrix(cbind(colnames(tmp.cleanDat), tmp.Dx_Group, t(tmp.cleanDat)))); 
  colnames(datMatrix)[1:offset] <- c("channels","Dx_Group"); 
  datMatrix                    <- datMatrix[which(!is.na(datMatrix$Dx_Group)),]
  
  #SETUP MODEL
  #-----------------------------------------------------------------------------
  ANOVA_Results                <- tuk_Results           <- list()
  resultAnovaStat              <- data.frame()
  
  for (i in (offset+1):ncol(datMatrix)){
    #One-way Anova
    tmp.data                   <- as.data.frame(as.numeric(datMatrix[,i]));
    if (is.null(level))        level=rev(names(table(tmp.Dx_Group)))
    Dx_Group                   <- factor(datMatrix$Dx_Group, levels = level)
    #print(rownames(cleanDat.input)[i])
    #***********************ANOVA***********************************************
    if(TRUE){
      tmpDf                     <- data.frame(group = Dx_Group, val=tmp.data); colnames(tmpDf)=c( "group","val")
      
      aov                       <- aov(unlist(tmp.data)~Dx_Group, data=tmp.data)
      summary(aov)    
      
      tmpDf %>% kruskal_test(val~group)
      tmpDf %>% kruskal_effsize(val~group)
      tmpDf %>% pairwise_wilcox_test(val~group, paired=FALSE)
      tmpDf %>% wilcox_effsize(val~group)
      tmpDf %>% dunn_test(val~group)
      tmpDf %>% t_test(val~group)
      tmpDf %>% anova_test(val~group)
      t.test(val~group, data=tmpDf)
      
      kruskal.test(val~group, data=tmpDf)
      pairwise.wilcox.test(tmpDf$val,tmpDf$group, paired=FALSE)
      dunnTest(val~group,data=tmpDf)
      dunn.test(tmpDf$val,tmpDf$group)
      
      
      #Changes below - added tryCatch to error. F stat & effect size set to 0 & P-values set to 1 in case of error
      anova_out                 <- tryCatch(anova(aov(unlist(tmp.data)~Dx_Group, data=tmp.data)), 
                                            error=function(e) (ANOVA_Results[[i-offset-1]]*0+1))
      tuk_out                    <- tryCatch(as.data.frame(TukeyHSD(aov(unlist(tmp.data)~Dx_Group, data=tmp.data))[[1]]), 
                                             error=function(e){
                                               tuk_out    = tuk_Results[i-offset-1][[1]];
                                               for (indx in 1:tuk_indx){
                                                 tuk_out[indx,1:3]= 0;
                                                 tuk_out[indx,4]  = 1;
                                               }
                                               return(tuk_out)
                                             })
    }
    # anova_out                   <- list(anova_out)
    tuk_out                     <- list(tuk_out)
    ANOVA_Results[[i-offset]]   <- anova_out
    tuk_Results[[i-offset]]     <- tuk_out
    
    
    
    
    
    #Two vs. more than two contrasts
    if (i==(offset+1)){ 
      #Set Column Headers
      tuk_indx                 <- dim(tuk_out[[1]])[1]                          
      headerOutput             <- c(names(anova_out)[4], names(anova_out)[5])
      for (indx in 1:tuk_indx){
        headerOutput         <- c(headerOutput, colnames(tuk_out[[1]])[4], rownames(tuk_out[[1]])[indx]) 
      }
    }
    #Add data per contrast     
    resultAnovaStat_iter       <- c(anova_out$`F value`[1], anova_out$`Pr(>F)`[1])#   , tuk_out$Dx_Group[c(4,1)])
    for (indx in 1:tuk_indx){
      resultAnovaStat_iter    <-  c(resultAnovaStat_iter, tuk_out[[1]][indx,4], tuk_out[[1]][indx, 1]) 
    }
    resultAnovaStat            <- rbind(resultAnovaStat, resultAnovaStat_iter)
  }
  
  colnames(resultAnovaStat)    <- headerOutput; 
  rownames(resultAnovaStat)    <- rownames(tmp.cleanDat)
  thisCleanDat.symbols         <- as.data.frame(do.call("rbind",strsplit(rownames(tmp.cleanDat),";|]")))[,1]
  thisCleanDat.symbols         <- as.data.frame(do.call("rbind",strsplit(thisCleanDat.symbols,"[|]")))[,1]
  
  thisCleanDat.MEGAcolors      <- netMEGA$colors[match(thisCleanDat.symbols,MEGAsymbols)]
  thisCleanDat.MEGAcolors[which(thisCleanDat.symbols=="0")]<-"grey40"
  thisCleanDat.MEGAcolors[is.na(thisCleanDat.MEGAcolors)]<-"grey40"
  
  resultAnovaStat$NETcolors    <- thisCleanDat.MEGAcolors
  resultAnovaStat$Modules      <- this.modOntol$Name[match(resultAnovaStat$NETcolors,this.modOntol$color)]
  #############################
  if (csfModuleFlag){
    resultAnovaStat$CSFModules   <- csfModule$Modules[match(thisCleanDat.symbols, csfModule$Symbols)]
    resultAnovaStat$CSFcolors    <- csfModule$Color[match(thisCleanDat.symbols, csfModule$Symbols)]
  }
  ############################
  resultAnovaStat$P_BH         <- as.vector(p.adjust(resultAnovaStat[,2], method = "BH"))
  resultAnovaStat$P_ADJ        <- as.vector(p.adjust(resultAnovaStat[,2], method = p_adj_Mthd))
  
  
  
  
  return(list(anovaResults = resultAnovaStat[order(resultAnovaStat$P_ADJ),], anovaParams = ANOVA_Results, tukParams = tuk_Results))
}

helper_ANCOVA_temp <- function(tmp.cleanDat, tmp.Dx_Group, p_adj_Mthd, level, csfModuleFlag){
  #CURRENT CAPABILITY
  # - ONE WAY ANOVA Using aov/TukeyHSD in case contrast includes two variables only
  # - ONE WAY Multi-contrast Anova using aov/TukeyHSD
  #** Repeated Measures Anova
  #** Mixed Effects Modeling (Check for model fit - Normal vs. others; Fixed and Confounding variable modeling)
  
  
  if(FALSE){
    tmp.cleanDat  = cleanDat.input
    tmp.Dx_Group  = drugStatus
    
  }
  
  #PREP DATA
  #-----------------------------------------------------------------------------
  load(paste0(global.inputDirectory,"MEGA488_forORA.RData"))
  MEGAsymbols                  <- as.data.frame(do.call("rbind",strsplit(names(netMEGA$colors),"[|]")))[,1]
  this.modOntol                <-read.csv(file=paste0(global.inputDirectory,"_MEGA488_modDefinitions.csv"),header=FALSE); colnames(this.modOntol)<-c("color","Name")
  
  #################
  if (csfModuleFlag){
    csfModule                    <- as.data.frame(read.csv(paste0(global.inputDirectory,"CSF_Modules_10.10.2023.csv"))); colnames(csfModule)<-c("GENE_PROTEIN","Symbols", "Proteins", "Color", "Modules")
  }
  #################
  
  p_adj_Mthd                   <- p_adj_Mthd
  #SETUP UP DATA 
  #-----------------------------------------------------------------------------
  tmp.cleanDat                 <- as.data.frame(tmp.cleanDat)
  tmp.Dx_Group                 <- tmp.Dx_Group
  offset                       <- 2
  datMatrix                    <- as.data.frame(as.matrix(cbind(colnames(tmp.cleanDat), tmp.Dx_Group, t(tmp.cleanDat)))); 
  colnames(datMatrix)[1:offset] <- c("channels","Dx_Group"); 
  datMatrix                    <- datMatrix[which(!is.na(datMatrix$Dx_Group)),]
  
  #SETUP MODEL
  #-----------------------------------------------------------------------------
  ANOVA_Results                <- tuk_Results           <- list()
  resultAnovaStat              <- data.frame()
  
  for (i in (offset+1):ncol(datMatrix)){
    #One-way Anova
    tmp.data                   <- as.data.frame(as.numeric(datMatrix[,i]));
    if (is.null(level))        level=rev(names(table(tmp.Dx_Group)))
    Dx_Group                   <- factor(datMatrix$Dx_Group, levels = level)
    #print(rownames(cleanDat.input)[i])
    #***********************ANOVA***********************************************
    if(TRUE){
      tmpDf                     <- data.frame(group = Dx_Group, val=tmp.data); colnames(tmpDf)=c( "group","val")
      
      aov                       <- aov(unlist(tmp.data)~Dx_Group, data=tmp.data)
      summary(aov)    
      
      tmpDf %>% kruskal_test(val~group)
      tmpDf %>% kruskal_effsize(val~group)
      tmpDf %>% pairwise_wilcox_test(val~group, paired=FALSE)
      tmpDf %>% wilcox_effsize(val~group)
      tmpDf %>% dunn_test(val~group)
      
      kruskal.test(val~group, data=tmpDf)
      pairwise.wilcox.test(tmpDf$val,tmpDf$group, paired=FALSE)
      dunnTest(val~group,data=tmpDf)
      dunn.test(tmpDf$val,tmpDf$group)
      
      
      #Changes below - added tryCatch to error. F stat & effect size set to 0 & P-values set to 1 in case of error
      anova_out                 <- tryCatch(anova(aov(unlist(tmp.data)~Dx_Group, data=tmp.data)), 
                                            error=function(e) (ANOVA_Results[[i-offset-1]]*0+1))
      tuk_out                    <- tryCatch(as.data.frame(TukeyHSD(aov(unlist(tmp.data)~Dx_Group, data=tmp.data))[[1]]), 
                                             error=function(e){
                                               tuk_out    = tuk_Results[i-offset-1][[1]];
                                               for (indx in 1:tuk_indx){
                                                 tuk_out[indx,1:3]= 0;
                                                 tuk_out[indx,4]  = 1;
                                               }
                                               return(tuk_out)
                                             })
    }
    # anova_out                   <- list(anova_out)
    tuk_out                     <- list(tuk_out)
    ANOVA_Results[[i-offset]]   <- anova_out
    tuk_Results[[i-offset]]     <- tuk_out
    
    
    
    
    
    #Two vs. more than two contrasts
    if (i==(offset+1)){ 
      #Set Column Headers
      tuk_indx                 <- dim(tuk_out[[1]])[1]                          
      headerOutput             <- c(names(anova_out)[4], names(anova_out)[5])
      for (indx in 1:tuk_indx){
        headerOutput         <- c(headerOutput, colnames(tuk_out[[1]])[4], rownames(tuk_out[[1]])[indx]) 
      }
    }
    #Add data per contrast     
    resultAnovaStat_iter       <- c(anova_out$`F value`[1], anova_out$`Pr(>F)`[1])#   , tuk_out$Dx_Group[c(4,1)])
    for (indx in 1:tuk_indx){
      resultAnovaStat_iter    <-  c(resultAnovaStat_iter, tuk_out[[1]][indx,4], tuk_out[[1]][indx, 1]) 
    }
    resultAnovaStat            <- rbind(resultAnovaStat, resultAnovaStat_iter)
  }
  
  colnames(resultAnovaStat)    <- headerOutput; 
  rownames(resultAnovaStat)    <- rownames(tmp.cleanDat)
  thisCleanDat.symbols         <- as.data.frame(do.call("rbind",strsplit(rownames(tmp.cleanDat),";|]")))[,1]
  thisCleanDat.symbols         <- as.data.frame(do.call("rbind",strsplit(thisCleanDat.symbols,"[|]")))[,1]
  
  thisCleanDat.MEGAcolors      <- netMEGA$colors[match(thisCleanDat.symbols,MEGAsymbols)]
  thisCleanDat.MEGAcolors[which(thisCleanDat.symbols=="0")]<-"grey40"
  thisCleanDat.MEGAcolors[is.na(thisCleanDat.MEGAcolors)]<-"grey40"
  
  resultAnovaStat$NETcolors    <- thisCleanDat.MEGAcolors
  resultAnovaStat$Modules      <- this.modOntol$Name[match(resultAnovaStat$NETcolors,this.modOntol$color)]
  #############################
  if (csfModuleFlag){
    resultAnovaStat$CSFModules   <- csfModule$Modules[match(thisCleanDat.symbols, csfModule$Symbols)]
    resultAnovaStat$CSFcolors    <- csfModule$Color[match(thisCleanDat.symbols, csfModule$Symbols)]
  }
  ############################
  resultAnovaStat$P_BH         <- as.vector(p.adjust(resultAnovaStat[,2], method = "BH"))
  resultAnovaStat$P_ADJ        <- as.vector(p.adjust(resultAnovaStat[,2], method = p_adj_Mthd))
  
  
  
  
  return(list(anovaResults = resultAnovaStat[order(resultAnovaStat$P_ADJ),], anovaParams = ANOVA_Results, tukParams = tuk_Results))
}


#--------------
# VOLCANO
#--------------

helper_makeVolcano <- function(InputAnova, cohort, p_adj_Mthd, fileName, moduleColor, BIGspots ){
  
  if(FALSE){
    InputAnova <- ANOVA_ALL[[case]]
    cohort     <-""
    p_adj_Mthd <-"none"
    fileName   <- FileBaseName
    moduleColor<- TRUE 
    BIGspots   <- bioMrkList
  }
  
  
  #1.A - READ THE DATA/INITIALIZE VARIABLES
  baseNameVolcanoes     <- paste0(fileName,"_","VolcanoPlot")        #Pick file_name for this cohort/batches 
  ANOVAout              <- InputAnova                                #Pick Anova results for this cohort  
  load(paste0(global.inputDirectory,"MEGA488_forORA.RData"))
  
  colnames(ANOVAout)                                                 #[1] "F value" | Pr(>F)" | P_adj  | "Diff: CTRL-AD" | "thisCleanDat.MEGAcolors"
  F_Val                 <- colnames(ANOVAout)[1]
  p_Tuk_Orig            <- colnames(ANOVAout)[2]
  DiffEx                <- colnames(ANOVAout)[4]
  p_Adj                 <- "P_ADJ"                                   #colnames(ANOVAout)[3]
  
  
  #1.B SET THRESHOLDS 
  cutoff                       <- log2(1)                            # log2(1) means NO change minimum to be counted in the volcano bookends; log2(1.25) for 25% FC min.
  sigCutoff                    <- 0.05                               # p value cutoff for Volcano significant hit counting; dashed line at -log10(sigCutoff)
  useNETcolors                 <- moduleColor                               # Use WGCNA colors if TRUE, otherwise red=up, green=down, and blue=no change beyond cutoffs
  splitColors                  <- FALSE                              # Make a separate volcano for each color of spot?
  BIGspots                     <- BIGspots                           #c()  # c('TARDBP','C9ORF72','SCA36','SCA3','SQSTM1','SFPQ','MSN','PLEC','HEPACAM') #which gene symbols should be checked for and highlighted as bigger spots, if any?
  
  #1.C SET UP THE DATA & QC
  df                           <- ANOVAout
  df[which(df[, p_Adj] == 0), p_Adj]   <- as.numeric(df[which(df[, p_Adj] == 0), p_Tuk_Orig])
  df[, p_Adj][is.na(df[, p_Adj])]      <- 1                                             # p=0.9999 instead of NA
  df[, DiffEx][is.na(df[, DiffEx])]    <- 0                                             # log2(difference)=0 instead of NA
  df$negLogP                           <- -log10(as.numeric(df[, p_Adj]))
  df$threshold1                        <- as.numeric(rep(0, dim(df)[1]))
  
  #1.D SET THE THRESHOLDS FOR COLORING TRENDS 
  for (i in 1:dim(df)[1]) {
    if (abs(as.numeric(df[i, DiffEx])) < cutoff | as.numeric(df[i, p_Adj]) > sigCutoff) 
    {df$threshold1[i]                                                                                     <- 3     #Live data
    } else {
      if (as.numeric(df[i, DiffEx]) < cutoff) {df$threshold1[i]                                           <- 2     #DiffEX
      } else {
        df$threshold1[i]                                                                                  <- 1     #DiffEx?
      }
    }
  }
  df$threshold1                 <- as.factor(df$threshold1)
  df$Symbol                     <- rownames(df)                      #for symbol only:  do.call("rbind", strsplit(as.character(rownames(df)), "[|]"))[, 1]
  
  #1.E. DEFINE COLOR SCHEME - (module or other) colors, SPLITTABLE on COLOR
  pointColorsVectorListForPlots<- list()                              #All Colors
  volcListModColorsWeb         <- list()                              #Module Colors
  volcListModColors            <- list()                              #Module Colors
  dfListModColors              <- list()                              #Module Colors 
  
  ## Color Interesting Gene Product Spots DIFFERENTLY as 4th color if doing blue/red/green (no module colors) -- (4=gold1 below)
  if(useNETcolors) { 
    df$color1                <- df$NETcolors
    df$threshold2            <- as.numeric(df$threshold1)
    df$threshold2[match(intersect(df$Symbol, BIGspots), df$Symbol)] <- 4 
  } else {
    df$color1                <- as.numeric(df$threshold1)
    df$threshold2            <- as.numeric(df$threshold1)                         #//////////////////
    df$color1[match(intersect(df$Symbol, BIGspots), df$Symbol)]     <- 4
  }
  df$color1                  <- as.factor(df$color1)
  
  if(useNETcolors) {
    df$threshold2            <- as.numeric(df$threshold1)
    df$threshold2[match(intersect(df$Symbol, BIGspots), df$Symbol)] <- 4 
    df$size1 <- as.numeric(df$threshold2)
  } else {
    df$size1 <- as.numeric(df$color1)
  }
  df$size1[df$size1 < 4]     <- 3.0
  df$size1[df$size1 == 4]    <- 6.0
  
  #df$color2: actual spot color as.character() ; df$color1 is a factorable dummy
  if(useNETcolors) {
    df$color2<-as.character(df$color1)
    df$color2[df$threshold2 == 4] <- "gold1" #for BIGspots
  } else {
    df$color2 <- as.numeric(df$color1)
    df$color2[df$color2 == 1] <- "darkred"
    df$color2[df$color2 == 2] <- "darkgreen"
    df$color2[df$color2 == 3] <- "dodgerblue"
    df$color2[df$color2 == 4] <- "gold1" #for BIGspots
  }                              #gold1 is also the 435th, last WGCNA unique color
  
  #df$color3 is outline color, where outlined pch symbols (21) used
  df$color3           <- df$color2
  df$color3[df$color3 == "gold1"] <- "black" #for BIGspots outline
  df$pch <- as.numeric(df$threshold2)
  df$pch[df$pch < 4]  <- 16 # unfilled circles (use color2)
  df$pch[df$pch == 4] <- 21 # filled, outlined circles (border uses color3)
  
  #put gold1 back to module color for fill of BIGspots if (useNETcolors)
  if (useNETcolors) { df$color2[df$color2=="gold1"] <- as.character(df$color1[df$color2=="gold1"]) }
  df <- df[order(df$size1, decreasing = FALSE), ] # puts larger dots on top (at bottom of df)
  
  #ADDED - Labels for highly significant proteins; 02.13.2022, KP---------------
  ANNOTATE = FALSE
  df$geneSymbol  = c("");
  if (ANNOTATE){
    df             <- df[order(df$P_ADJ, decreasing = FALSE), ] # puts larger dots on top (at bottom of df)
    df$geneSymbol  = df$Symbol
    #df$geneSymbol  = do.call(rbind,strsplit(df$Symbol,"[|]"))[,1]
    #df$geneSymbol[-c(which((df$Symbol %in% bioMrkList)))]<-""
    df$geneSymbol[which(df$P_ADJ>.05)]<-""
    #df$geneSymbol[which(df$P_ADJ>.05 & !(df$Symbol %in% bioMrkList))]<-""
  }
  
  
  #-----------------------------------------------------------------------------
  
  #splitColors TRUE/FALSE: FALSE - Make one volcano with all colors, or TRUE - make volcanoes for each color (TRUE)
  # SPLIT DATA FRAME FOR VOLCANO PLOT BY COLORS (if multiple eachColorSplit items)
  df.AllColors   <- df
  eachColorSplit <- if (splitColors) {
    unique(df.AllColors$NETcolors)
  } else {
    c("allcolors")
  }
  for (eachColor in eachColorSplit) {
    if (splitColors) {
      df.oneColor        <- df.AllColors[which(df.AllColors$NETcolors == eachColor), ]
      df.oneColor$color1 <- factor(df.oneColor$NETcolors)
    } else {
      df.oneColor <- df.AllColors
    } # end if (splitColors)
    
    names(df.oneColor)[4] <- DiffEx # x=as.numeric(df.oneColor[,testIndex+numComp])
    list_element <- paste(eachColor, sep = ".") # colnames(df)[testIndex]
    pointColorsVectorListForPlots[[list_element]] <- data.frame(color1 = factor(as.integer(df.oneColor$color1)), color2 = as.character(df.oneColor$color2), color3 = as.character(df.oneColor$color3), size = as.numeric(df.oneColor$size), pch = as.numeric(df.oneColor$pch)) #*** df.oneColor$NETcolors
    
    
    volcano1 <- ggplot(data = df.oneColor, aes(x = df.oneColor[,DiffEx], y = negLogP, color = color1, text = Symbol)) + 
      geom_point(aes(fill = pointColorsVectorListForPlots[[list_element]][, "color3"]), alpha = 0.66, size = pointColorsVectorListForPlots[[list_element]]$size, pch = pointColorsVectorListForPlots[[list_element]][, "pch"], color = pointColorsVectorListForPlots[[list_element]][, "color3"]) +
      theme(legend.position = "none") +
      geom_text(label=df$geneSymbol, nudge_x = .05, nudge_y = .05, check_overlap = T, color="black", size=2)+
      #xlab(paste0("Difference, log[2] ", DiffEx)) + # colnames(df.oneColor)[testIndex]
      #ylab(paste0("-log[10] p {", p_Adj, "=", p_adj_Mthd,"}")) +
      xlab(paste0("Difference, log[2]: ", DiffEx)) + # colnames(df.oneColor)[testIndex]
      ylab(paste0("-log[10] p | FDR = ", p_adj_Mthd)) +
      #xlab(paste0("Difference, log[2]: Gamma Oscillation vs. Baseline")) +
      #ylab(paste0("-log[10] p ")) +
      
      theme(axis.title.x = element_text(size = rel(1.8), angle = 00)) +
      theme(axis.title.y = element_text(size = rel(1.8), angle = 90)) +
      
      geom_hline(yintercept = abs(log10(sigCutoff)), linetype = "dashed", color = "black", size = 1.2) +
      #geom_hline(yintercept = abs(log10(0.1)), linetype = "dashed", color = "black", size = 1.2) +
      geom_vline(xintercept = cutoff, linetype = "dashed", color = "black", size = 1.2) +
      geom_vline(xintercept = -cutoff, linetype = "dashed", color = "black", size = 1.2) +
      #xlim(-.7,.7)+
      xlim(-2,2)+
      annotate("text", x = -0.55, y = max(df.oneColor$negLogP) * .95, size = 5, label = paste0("Downregulated:\n", bquote(.(length(which((df.oneColor$threshold1) == 2)))))) +
      annotate("text", x =  0.55, y = max(df.oneColor$negLogP) * .95, size = 5, label = paste0("Upregulated:\n", bquote(.(length(which((df.oneColor$threshold1) == 1)))))) +
      # annotate("text", x = min(as.numeric(df.oneColor[, 4])) / 2, y = max(df.oneColor$negLogP) * .95, size = 5, label = paste0("Downregulated:\n", bquote(.(length(which((df.oneColor$threshold1) == 2)))))) +
      # annotate("text", x = max(as.numeric(df.oneColor[, 4])) / 1.5, y = max(df.oneColor$negLogP) * .95, size = 5, label = paste0("Upregulated:\n", bquote(.(length(which((df.oneColor$threshold1) == 1)))))) +
      # #annotate("text", x = min(as.numeric(df.oneColor[, 4])) / 2, y = max(df.oneColor$negLogP) * .95, size = 5, label = paste0("Downregulated: ", bquote(.(length(which(as.numeric(df.oneColor$threshold1) == 2)))))) +
      #annotate("text", x = max(as.numeric(df.oneColor[, 4])) / 2, y = max(df.oneColor$negLogP) * .95, size = 5, label = paste0("Upregulated: ", bquote(.(length(which(as.numeric(df.oneColor$threshold1) == 1)))))) +
      
      theme(
        panel.grid.major = element_line(color = "darkgrey", linetype = "dashed"),
        panel.grid.minor = element_blank(),
        panel.background = element_rect(fill = "white")
      )
    
    
    # web version doesn't use as.expression! plotly fails with those, so we rebuild the volcano for the web.
    volcanoweb <- ggplot(data = df.oneColor, aes(x = df.oneColor[,DiffEx], y = negLogP, color = color1, text = Symbol)) +
      scale_colour_manual(values = unique(data.frame(col1 = df.oneColor$color1, col2 = df.oneColor$color2))[order(unique(data.frame(col1 = df.oneColor$color1, col2 = df.oneColor$color2))[, 1]), 2]) + # THIS COLOR(S) IS LOOKED UP ACTIVELY BY PLOTLY IN THE VARIABLE, SO WE'VE USED A LIST ELEMENT THAT IS NEVER CHANGED
      geom_point(alpha = 0.66, size = pointColorsVectorListForPlots[[list_element]]$size, pch = 16) + # pch=pointColorsVectorListForPlots[[list_element]][,"pch"] just uses the higher pch code in the web render.
      geom_text(label=df$geneSymbol, nudge_x = .025, nudge_y = .005, check_overlap = T, color="black", size=3)+
      theme(legend.position = "none") +
      #xlab(paste0("Difference, log[2] ", DiffEx)) + # colnames(df.oneColor)[testIndex]
      #ylab(paste0("-log[10] p {", p_Adj, "=", p_adj_Mthd,"}")) +
      xlab(paste0("Difference, log[2]: ", DiffEx)) + # colnames(df.oneColor)[testIndex]
      ylab(paste0("-log[10] p | FDR = ", p_adj_Mthd)) +
      #xlab(paste0("Difference, log[2]: Gamma Oscillation vs. Baseline")) +
      #ylab(paste0("-log[10] p ")) +
      theme(axis.title.x = element_text(size = rel(1.8), angle = 00)) +
      theme(axis.title.y = element_text(size = rel(1.8), angle = 90)) +
      
      geom_hline(yintercept = abs(log10(sigCutoff)), linetype = "dashed", color = "black", size = 1.2) +
      #geom_hline(yintercept = abs(log10(0.1)), linetype = "dashed", color = "black", size = 1.2) +
      geom_vline(xintercept = cutoff, linetype = "dashed", color = "black", size = 1.2) +
      geom_vline(xintercept = -cutoff, linetype = "dashed", color = "black", size = 1.2) +
      #xlim(-.7,.7)+
      xlim(-2,2)+
      annotate("text", x = -0.55, y = max(df.oneColor$negLogP) * .95, size = 5, label = paste0("Downregulated:\n", bquote(.(length(which((df.oneColor$threshold1) == 2)))))) +
      annotate("text", x =  0.55, y = max(df.oneColor$negLogP) * .95, size = 5, label = paste0("Upregulated:\n", bquote(.(length(which((df.oneColor$threshold1) == 1)))))) +
      # annotate("text", x = min(as.numeric(df.oneColor[, 4])) / 2.2, y = max(df.oneColor$negLogP) *.95, size = 5, label = paste0("Downregulated:\n ", bquote(.(length(which((df.oneColor$threshold1) == 2)))))) +
      # annotate("text", x = max(as.numeric(df.oneColor[, 4])) / 1.5, y = max(df.oneColor$negLogP) * .95, size = 5, label = paste0("Upregulated:\n ", bquote(.(length(which((df.oneColor$threshold1) == 1)))))) +
      # #annotate("text", x = min(as.numeric(df.oneColor[, 4])) / 2, y = max(df.oneColor$negLogP) * .95, size = 5, label = paste0("Downregulated: ", bquote(.(length(which(as.numeric(df.oneColor$threshold1) == 2)))))) +
      #annotate("text", x = max(as.numeric(df.oneColor[, 4])) / 2, y = max(df.oneColor$negLogP) * .95, size = 5, label = paste0("Upregulated: ", bquote(.(length(which(as.numeric(df.oneColor$threshold1) == 1)))))) +
      
      theme(
        #panel.grid.major = element_line(color = "darkgrey", linetype = "dashed"),
        #panel.grid.minor = element_blank(),
        panel.background = element_rect(fill = "white")
      )
    
    
    volcListModColors[[list_element]]    <- volcano1
    volcListModColorsWeb[[list_element]] <- volcanoweb
    
    print(volcano1) # prints to active output (separate page)
    rm(volcano1)
    rm(volcanoweb)
    dfListModColors[[list_element]] <- df.oneColor
  } # closes for(eachColor...
  
  
  file      <- paste0(global.datExplrStatRoot, baseNameVolcanoes, "_PDF","_", eachColor,".pdf")  
  pdf(file  = file, colormodel="srgb", height = 8, width = 8)
  par(mfrow = c(1, 1))
  par(mar = c(6, 8.5, 3, 3))
  print(volcListModColorsWeb[[list_element]])
  dev.off()
  
  
  library(plotly)
  webPlot                         <- ggplotly(volcListModColorsWeb[[list_element]])
  tempfilename                    <- paste0(global.datExplrStatRoot, baseNameVolcanoes, "_HTML", "_", eachColor,".html")
  htmlwidgets::saveWidget(webPlot, tempfilename, selfcontained = TRUE, libdir = "delete.me")
  
  return(list(volcanDat = df.oneColor))
  
} #END L1 - Cohort-wise iteration--------------------------------------------------------------------------------------------------------

helper_makeVolcanoAUC <- function(InputAnova, cohort, p_adj_Mthd, fileName, moduleColor, BIGspots, testAucDat ){
  
  if(FALSE){
    InputAnova <- anovaResults
    cohort     <-""
    p_adj_Mthd <-"none"
    fileName   <- FileBaseName
    BIGspots   <- bioMrkList
  }
  
  
  #1.A - READ THE DATA/INITIALIZE VARIABLES
  baseNameVolcanoes     <- paste0("VolcanoPlot","_",fileName)        #Pick file_name for this cohort/batches 
  ANOVAout              <- InputAnova                                #Pick Anova results for this cohort  
  load(paste0(global.inputDirectory,"MEGA488_forORA.RData"))
  
  colnames(ANOVAout)                                                 #[1] "F value" | Pr(>F)" | P_adj  | "Diff: CTRL-AD" | "thisCleanDat.MEGAcolors"
  F_Val                 <- colnames(ANOVAout)[1]
  p_Tuk_Orig            <- colnames(ANOVAout)[2]
  DiffEx                <- colnames(ANOVAout)[4]
  p_Adj                 <- "P_ADJ"                                   #colnames(ANOVAout)[3]
  
  
  #1.B SET THRESHOLDS 
  cutoff                       <- log2(1)                            # log2(1) means NO change minimum to be counted in the volcano bookends; log2(1.25) for 25% FC min.
  sigCutoff                    <- 0.1                               # p value cutoff for Volcano significant hit counting; dashed line at -log10(sigCutoff)
  useNETcolors                 <- moduleColor                               # Use WGCNA colors if TRUE, otherwise red=up, green=down, and blue=no change beyond cutoffs
  splitColors                  <- FALSE                              # Make a separate volcano for each color of spot?
  BIGspots                     <- BIGspots                           #c()  # c('TARDBP','C9ORF72','SCA36','SCA3','SQSTM1','SFPQ','MSN','PLEC','HEPACAM') #which gene symbols should be checked for and highlighted as bigger spots, if any?
  
  #1.C SET UP THE DATA & QC
  df                                   <- cbind(ANOVAout, testAucDat)
  df[which(df[, p_Adj] == 0), p_Adj]   <- as.numeric(df[which(df[, p_Adj] == 0), p_Tuk_Orig])
  df[, p_Adj][is.na(df[, p_Adj])]      <- 1                                             # p=0.9999 instead of NA
  df[, DiffEx][is.na(df[, DiffEx])]    <- 0                                             # log2(difference)=0 instead of NA
  df$negLogP                           <- -log10(as.numeric(df[, p_Adj]))
  df$threshold1                        <- as.numeric(rep(0, dim(df)[1]))
  
  #1.D SET THE THRESHOLDS FOR COLORING TRENDS 
  for (i in 1:dim(df)[1]) {
    if (abs(as.numeric(df[i, DiffEx])) < cutoff | as.numeric(df[i, p_Adj]) > sigCutoff) 
    {df$threshold1[i]                                                                                     <- 3     #Live data
    } else {
      if (as.numeric(df[i, DiffEx]) < cutoff) {df$threshold1[i]                                           <- 2     #DiffEX
      } else {
        df$threshold1[i]                                                                                  <- 1     #DiffEx?
      }
    }
  }
  df$threshold1                 <- as.factor(df$threshold1)
  df$Symbol                     <- rownames(df)                      #for symbol only:  do.call("rbind", strsplit(as.character(rownames(df)), "[|]"))[, 1]
  
  #1.E. DEFINE COLOR SCHEME - (module or other) colors, SPLITTABLE on COLOR
  pointColorsVectorListForPlots<- list()                              #All Colors
  volcListModColorsWeb         <- list()                              #Module Colors
  volcListModColors            <- list()                              #Module Colors
  dfListModColors              <- list()                              #Module Colors 
  
  ## Color Interesting Gene Product Spots DIFFERENTLY as 4th color if doing blue/red/green (no module colors) -- (4=gold1 below)
  if(useNETcolors) { 
    df$color1                <- df$NETcolors
    df$threshold2            <- as.numeric(df$threshold1)
    df$threshold2[match(intersect(df$Symbol, BIGspots), df$Symbol)] <- 4 
  } else {
    df$color1                <- as.numeric(df$threshold1)
    df$threshold2            <- as.numeric(df$threshold1)                         #//////////////////
    df$color1[match(intersect(df$Symbol, BIGspots), df$Symbol)]     <- 4
  }
  df$color1                  <- as.factor(df$color1)
  
  if(useNETcolors) {
    df$threshold2            <- as.numeric(df$threshold1)
    df$threshold2[match(intersect(df$Symbol, BIGspots), df$Symbol)] <- 4 
    df$size1 <- as.numeric(df$threshold2)
  } else {
    df$size1 <- as.numeric(df$color1)
  }
  
  df$size1 = 4
  df$size1[df$testAucDat>=.9] = 30
  df$size1[df$testAucDat<.9 & df$testAucDat>=.8] = 20
  df$size1[df$testAucDat<.8 & df$testAucDat>=.7] = 6
  
  #df$size1[df$size1 < 4]     <- 3.0
  #df$size1[df$size1 == 4]    <- 6.0
  
  #df$color2: actual spot color as.character() ; df$color1 is a factorable dummy
  if(useNETcolors) {
    df$color2<-as.character(df$color1)
    df$color2[df$threshold2 == 4] <- "gold1" #for BIGspots
  } else {
    df$color2 <- as.numeric(df$color1)
    df$color2[df$color2 == 1] <- "darkred"
    df$color2[df$color2 == 2] <- "darkgreen"
    df$color2[df$color2 == 3] <- "dodgerblue"
    df$color2[df$color2 == 4] <- "gold1" #for BIGspots
  }                              #gold1 is also the 435th, last WGCNA unique color
  
  #df$color3 is outline color, where outlined pch symbols (21) used
  df$color3           <- df$color2
  df$color3[df$color3 == "gold1"] <- "black" #for BIGspots outline
  df$pch <- as.numeric(df$threshold2)
  df$pch[df$pch < 4]  <- 16 # unfilled circles (use color2)
  df$pch[df$pch == 4] <- 21 # filled, outlined circles (border uses color3)
  
  #put gold1 back to module color for fill of BIGspots if (useNETcolors)
  if (useNETcolors) { df$color2[df$color2=="gold1"] <- as.character(df$color1[df$color2=="gold1"]) }
  df <- df[order(df$size1, decreasing = FALSE), ] # puts larger dots on top (at bottom of df)
  
  #ADDED - Labels for highly significant proteins; 02.13.2022, KP---------------
  ANNOTATE = TRUE
  df$geneSymbol  = c("");
  if (ANNOTATE){
    df             <- df[order(df$P_ADJ, decreasing = FALSE), ] # puts larger dots on top (at bottom of df)
    df$geneSymbol  = df$Symbol
    #df$geneSymbol  = do.call(rbind,strsplit(df$Symbol,"[|]"))[,1]
    #df$geneSymbol[-c(which((df$Symbol %in% bioMrkList)))]<-""
    #df$geneSymbol[which(df$P_ADJ>.05)]<-""
    df$geneSymbol[which(df$testAucDat<=.8)]<-""
    #df$geneSymbol[which(df$P_ADJ>.05 & !(df$Symbol %in% bioMrkList))]<-""
  }
  
  #-----------------------------------------------------------------------------
  
  #splitColors TRUE/FALSE: FALSE - Make one volcano with all colors, or TRUE - make volcanoes for each color (TRUE)
  # SPLIT DATA FRAME FOR VOLCANO PLOT BY COLORS (if multiple eachColorSplit items)
  df.AllColors   <- df
  eachColorSplit <- if (splitColors) {
    unique(df.AllColors$NETcolors)
  } else {
    c("allcolors")
  }
  for (eachColor in eachColorSplit) {
    if (splitColors) {
      df.oneColor        <- df.AllColors[which(df.AllColors$NETcolors == eachColor), ]
      df.oneColor$color1 <- factor(df.oneColor$NETcolors)
    } else {
      df.oneColor <- df.AllColors
    } # end if (splitColors)
    
    names(df.oneColor)[4] <- DiffEx # x=as.numeric(df.oneColor[,testIndex+numComp])
    list_element <- paste(eachColor, sep = ".") # colnames(df)[testIndex]
    pointColorsVectorListForPlots[[list_element]] <- data.frame(color1 = factor(as.integer(df.oneColor$color1)), color2 = as.character(df.oneColor$color2), color3 = as.character(df.oneColor$color3), size = as.numeric(df.oneColor$size), pch = as.numeric(df.oneColor$pch)) #*** df.oneColor$NETcolors
    
    
    volcano1 <- ggplot(data = df.oneColor, aes(x = df.oneColor[,DiffEx], y = negLogP, color = color1, text = Symbol)) + 
      geom_point(aes(fill = pointColorsVectorListForPlots[[list_element]][, "color3"]), alpha = 0.66, size = pointColorsVectorListForPlots[[list_element]]$size, pch = pointColorsVectorListForPlots[[list_element]][, "pch"], color = pointColorsVectorListForPlots[[list_element]][, "color3"]) +
      theme(legend.position = "none") +
      geom_text(label=df$geneSymbol, nudge_x = .05, nudge_y = .05, check_overlap = T, color="black", size=2)+
      #xlab(paste0("Difference, log[2] ", DiffEx)) + # colnames(df.oneColor)[testIndex]
      #ylab(paste0("-log[10] p {", p_Adj, "=", p_adj_Mthd,"}")) +
      xlab(paste0("Difference, log[2]: ", DiffEx)) + # colnames(df.oneColor)[testIndex]
      ylab(paste0("-log[10] p | FDR = ", p_adj_Mthd)) +
      
      theme(axis.title.x = element_text(size = rel(1.8), angle = 00)) +
      theme(axis.title.y = element_text(size = rel(1.8), angle = 90)) +
      
      geom_hline(yintercept = abs(log10(sigCutoff)), linetype = "dashed", color = "black", size = 1.2) +
      geom_vline(xintercept = cutoff, linetype = "dashed", color = "black", size = 1.2) +
      geom_vline(xintercept = -cutoff, linetype = "dashed", color = "black", size = 1.2) +
      xlim(-1.5,1.5)+
      annotate("text", x = min(as.numeric(df.oneColor[, 4])) / 2, y = max(df.oneColor$negLogP) * .95, size = 5, label = paste0("Downregulated:\n", bquote(.(length(which((df.oneColor$threshold1) == 2)))))) +
      annotate("text", x = max(as.numeric(df.oneColor[, 4])) / 1.5, y = max(df.oneColor$negLogP) * .95, size = 5, label = paste0("Upregulated:\n", bquote(.(length(which((df.oneColor$threshold1) == 1)))))) +
      #annotate("text", x = min(as.numeric(df.oneColor[, 4])) / 2, y = max(df.oneColor$negLogP) * .95, size = 5, label = paste0("Downregulated: ", bquote(.(length(which(as.numeric(df.oneColor$threshold1) == 2)))))) +
      #annotate("text", x = max(as.numeric(df.oneColor[, 4])) / 2, y = max(df.oneColor$negLogP) * .95, size = 5, label = paste0("Upregulated: ", bquote(.(length(which(as.numeric(df.oneColor$threshold1) == 1)))))) +
      
      theme(
        panel.grid.major = element_line(color = "darkgrey", linetype = "dashed"),
        panel.grid.minor = element_blank(),
        panel.background = element_rect(fill = "white")
      )
    
    
    # web version doesn't use as.expression! plotly fails with those, so we rebuild the volcano for the web.
    volcanoweb <- ggplot(data = df.oneColor, aes(x = df.oneColor[,DiffEx], y = negLogP, color = color1, text = Symbol)) +
      scale_colour_manual(values = unique(data.frame(col1 = df.oneColor$color1, col2 = df.oneColor$color2))[order(unique(data.frame(col1 = df.oneColor$color1, col2 = df.oneColor$color2))[, 1]), 2]) + # THIS COLOR(S) IS LOOKED UP ACTIVELY BY PLOTLY IN THE VARIABLE, SO WE'VE USED A LIST ELEMENT THAT IS NEVER CHANGED
      geom_point(alpha = 0.66, size = pointColorsVectorListForPlots[[list_element]]$size, pch = 16) + # pch=pointColorsVectorListForPlots[[list_element]][,"pch"] just uses the higher pch code in the web render.
      geom_text(label=df$geneSymbol, nudge_x = .025, nudge_y = .005, check_overlap = T, color="black", size=3)+
      theme(legend.position = "none") +
      #xlab(paste0("Difference, log[2] ", DiffEx)) + # colnames(df.oneColor)[testIndex]
      #ylab(paste0("-log[10] p {", p_Adj, "=", p_adj_Mthd,"}")) +
      xlab(paste0("Difference, log[2]: ", DiffEx)) + # colnames(df.oneColor)[testIndex]
      ylab(paste0("-log[10] p | FDR = ", p_adj_Mthd)) +
      theme(axis.title.x = element_text(size = rel(1.8), angle = 00)) +
      theme(axis.title.y = element_text(size = rel(1.8), angle = 90)) +
      
      geom_hline(yintercept = abs(log10(sigCutoff)), linetype = "dashed", color = "black", size = 1.2) +
      geom_vline(xintercept = cutoff, linetype = "dashed", color = "black", size = 1.2) +
      geom_vline(xintercept = -cutoff, linetype = "dashed", color = "black", size = 1.2) +
      xlim(-1.5,1.5)+
      annotate("text", x = min(as.numeric(df.oneColor[, 4])) / 2.2, y = max(df.oneColor$negLogP) *.95, size = 5, label = paste0("Downregulated:\n ", bquote(.(length(which((df.oneColor$threshold1) == 2)))))) +
      annotate("text", x = max(as.numeric(df.oneColor[, 4])) / 1.5, y = max(df.oneColor$negLogP) * .95, size = 5, label = paste0("Upregulated:\n ", bquote(.(length(which((df.oneColor$threshold1) == 1)))))) +
      #annotate("text", x = min(as.numeric(df.oneColor[, 4])) / 2, y = max(df.oneColor$negLogP) * .95, size = 5, label = paste0("Downregulated: ", bquote(.(length(which(as.numeric(df.oneColor$threshold1) == 2)))))) +
      #annotate("text", x = max(as.numeric(df.oneColor[, 4])) / 2, y = max(df.oneColor$negLogP) * .95, size = 5, label = paste0("Upregulated: ", bquote(.(length(which(as.numeric(df.oneColor$threshold1) == 1)))))) +
      
      theme(
        #panel.grid.major = element_line(color = "darkgrey", linetype = "dashed"),
        #panel.grid.minor = element_blank(),
        panel.background = element_rect(fill = "white")
      )
    
    
    volcListModColors[[list_element]]    <- volcano1
    volcListModColorsWeb[[list_element]] <- volcanoweb
    
    print(volcano1) # prints to active output (separate page)
    rm(volcano1)
    rm(volcanoweb)
    dfListModColors[[list_element]] <- df.oneColor
  } # closes for(eachColor...
  
  
  file      <- paste0(global.datExplrFeatureProc, cohort, "Volcano_AUC", eachColor,"-",baseNameVolcanoes,".pdf")  
  pdf(file  = file, colormodel="srgb", height = 8, width = 8)
  par(mfrow = c(1, 1))
  par(mar = c(6, 8.5, 3, 3))
  print(volcListModColorsWeb[[list_element]])
  dev.off()
  
  
  library(plotly)
  webPlot                         <- ggplotly(volcListModColorsWeb[[list_element]])
  tempfilename                    <- paste0(global.datExplrFeatureProc, cohort, "HTMLvolcano_AUC",eachColor,"-",baseNameVolcanoes,".html")
  htmlwidgets::saveWidget(webPlot, tempfilename, selfcontained = TRUE, libdir = "delete.me")
  
  return(list(volcanDat = df.oneColor))
  
} #END L1 - Cohort-wise iteration--------------------------------------------------------------------------------------------------------


###HELPER FUNCTIONS#############################################################

#BoxPlots
createBoxPlots <- function(datInput, contrast, Anova_Filter, threshold){
  #Number of biomarkers and prioritization
  #Anova_Filter   <-Anova_Filter[order(-1*abs(Anova_Filter$`Drug-Placebo`)), ]; 
  #Anova_Filter   <-Anova_Filter[order(-1*abs(Anova_Filter[,4])), ];
  #Anova_Filter   <-Anova_Filter[which(Anova_Filter$`p adj`<threshold),]; 
  Anova_Filter   <-Anova_Filter[which(Anova_Filter$`Pr(>F)`  <threshold),]; 
  
  #Saving plots into pdf
  this.modOntol    <-read.csv(file=paste0(global.inputDirectory,"_MEGA488_modDefinitions.csv"),header=FALSE)
  colnames(this.modOntol)<-c("color","Name")
  pdf(file=paste0(this.dataExplrStatRoot, FileBaseName, "_Boxplots & Stats.pdf"),width=8,height=12)
  par(mfrow=c(3,2));par(mar=c(3,2,4,2)); par(oma=c(2,2,2,2))
  
  #Make plots
  for (i in 1:nrow(Anova_Filter) ) {
    titlecolor <- "black"
    boxplot(as.numeric(unlist(datInput[rownames(Anova_Filter[i,]),]))~factor(contrast, levels=level),col=Anova_Filter$NETcolors[i],ylab="log2(Abundance)",
            main=paste0(paste0(unlist(strsplit(rownames(Anova_Filter)[i], "[.]"))[1:2], collapse=""),"\nModule: ",
                        this.modOntol[which(this.modOntol$color==Anova_Filter$NETcolors[i]),"Name"],"\n ANOVA p = ",signif(as.numeric(Anova_Filter$P_ADJ[i]),2)),xlab=NULL,col.main=titlecolor,outline=FALSE)  #rotate X-labels: las=2  no outliers: ,outline=FALSE)
    transcol=paste0(col2hex(Anova_Filter$NETcolors[i]),"99") # paste0(col2hex("violet"),"99") + geom_point(position=jitter)
    beeswarm(as.numeric(unlist(datInput[rownames(Anova_Filter[i,]),]))~factor(contrast, levels=level),method="swarm",add=TRUE,corralWidth=0.5,vertical=TRUE,pch=.2,bg=transcol,col="black",cex=1.5,corral="gutter") #more like prism
  }
  dev.off()
  print(" ---COMPLETED BOX-PLOTS RESULTS")
}

createBoxPlots_Modules <- function(datInput, contrast, Anova_Filter, threshold){
  #Sort biomarkers by modules
  Anova_Filter   <-Anova_Filter[order(Anova_Filter[,6]), ];
  Anova_Filter   <-Anova_Filter[which(Anova_Filter$`p adj`<threshold),]; 
  
  #Saving plots into pdf
  this.modOntol    <-read.csv(file=paste0(global.inputDirectory,"_MEGA488_modDefinitions.csv"),header=FALSE)
  colnames(this.modOntol)<-c("color","Name")
  pdf(file=paste0(this.dataExplrStatRoot, FileBaseName, "_Boxplots & Stats_Modules.pdf"),width=8,height=12)
  par(mfrow=c(3,2));par(mar=c(3,2,4,2)); par(oma=c(2,2,2,2))
  
  #Make plots
  for (i in 1:nrow(Anova_Filter) ) {
    titlecolor <- "black"
    boxplot(as.numeric(unlist(datInput[rownames(Anova_Filter[i,]),]))~factor(contrast, levels=level),col=Anova_Filter$NETcolors[i],ylab="log2(Abundance)",
            main=paste0(paste0(unlist(strsplit(rownames(Anova_Filter)[i], "[.]"))[1:2], collapse=""),"\nMEGA module: ",
                        this.modOntol[which(this.modOntol$color==Anova_Filter$NETcolors[i]),"Name"],"\n ANOVA p = ",signif(as.numeric(Anova_Filter$P_ADJ[i]),2)),xlab=NULL,col.main=titlecolor,outline=FALSE)  #rotate X-labels: las=2  no outliers: ,outline=FALSE)
    transcol=paste0(col2hex(Anova_Filter$NETcolors[i]),"99") # paste0(col2hex("violet"),"99") + geom_point(position=jitter)
    beeswarm(as.numeric(unlist(datInput[rownames(Anova_Filter[i,]),]))~factor(contrast, levels=level),method="swarm",add=TRUE,corralWidth=0.5,vertical=TRUE,pch=.2,bg=transcol,col="black",cex=1.5,corral="gutter") #more like prism
  }
  dev.off()
  print(" ---COMPLETED BOX-PLOTS RESULTS")
}

createBoxPlots_NonModules <- function(datInput, contrast, Anova_Filter, threshold){
  #Number of biomarkers and prioritization
  #Anova_Filter   <-Anova_Filter[order(-1*abs(Anova_Filter$`Drug-Placebo`)), ]; 
  #Anova_Filter   <-Anova_Filter[order(-1*abs(Anova_Filter[,4])), ];
  Anova_Filter   <-Anova_Filter[which(Anova_Filter$P_ADJ<threshold),]; 
  
  #Saving plots into pdf
  pdf(file=paste0(this.dataExplrStatRoot, FileBaseName, "_Boxplots & Stats.pdf"),width=8,height=12)
  par(mfrow=c(3,2));par(mar=c(3,2,4,2)); par(oma=c(2,2,2,2))
  
  #Make plots
  for (i in 1:nrow(Anova_Filter) ) {
    titlecolor <- "black"
    boxplot(as.numeric(unlist(datInput[rownames(Anova_Filter[i,]),]))~factor(contrast, levels=level),col="gray",ylab="log2(Abundance)",
            main=paste0(paste0(unlist(strsplit(rownames(Anova_Filter)[i], "[.]"))[1:2], collapse=""),"\n ANOVA p = ",signif(as.numeric(Anova_Filter$P_ADJ[i]),2)),xlab=NULL,col.main=titlecolor,outline=FALSE)  #rotate X-labels: las=2  no outliers: ,outline=FALSE)
    transcol=paste0(col2hex(Anova_Filter$NETcolors[i]),"99") # paste0(col2hex("violet"),"99") + geom_point(position=jitter)
    beeswarm(as.numeric(unlist(datInput[rownames(Anova_Filter[i,]),]))~factor(contrast, levels=level),method="swarm",add=TRUE,corralWidth=0.5,vertical=TRUE,pch=.2,bg=transcol,col="black",cex=1.5,corral="gutter") #more like prism
  }
  dev.off()
  print(" ---COMPLETED BOX-PLOTS RESULTS")
}

#Heirarchical clustering
createCluster<-function(cleanDat.input, drugStatus, case, threshold){
  datInput             <- data.frame(sapply(cleanDat.input, function(x) as.numeric(as.character(x)))); rownames(datInput)<- rownames(cleanDat.input)
  contrast             <- drugStatus
  Grouping_Heirarchies <- data.frame(Status=contrast)
  if (nrow(unique(Grouping_Heirarchies))==3){
    heatmapLegendColors=list('Status'=c("darkred","darkgreen","darkturquoise"))
    heatmapLegendColors=list('Status'=c("darkred","darkturquoise","darkgreen"))
  } else {
    heatmapLegendColors=list('Status'=c("darkred","darkgreen", "darkturquoise", "blue"))  #, 'Gender'=c("pink","dodgerblue"))
  }                          
  
  Anova_Filter         <- ANOVA_ALL[[case]]
  Anova_Filter         <- Anova_Filter[which(Anova_Filter$P_ADJ<threshold),]; 
  
  #A. Creating Datasets for CLUSTERING & MDS
  datInput_Z.xForm     <- datInput
  datInput_Z.xForm     <- (datInput_Z.xForm-rowMeans(datInput,na.rm=TRUE))/apply(datInput,1,sd,na.rm=TRUE) #Z-transform: (x-mu)/SD
  datInput_Z.xForm[datInput_Z.xForm>4]  <- 4; datInput_Z.xForm[datInput_Z.xForm< -4]<- -4                 #max z +/- 4 for better clustering
  
  #B. Creating HEATMAPS/CLUSTERING<-
  png(file=paste0(global.datExplrStatRoot, FileBaseName, "_HC_p",threshold,".jpeg"), width=17, height=15, units="cm", res=400)
  x                  = datInput_Z.xForm[rownames(Anova_Filter),]
  aheatmap(x, ## Numeric Matrix
           main      = paste0("Clustering of n=",nrow(x)," proteins with sig. p<", threshold, " among \nALL ",nrow(datInput_Z.xForm)," baseline-subtracted & Z-transformed proteins"),
           annCol    = Grouping_Heirarchies,
           annColors = heatmapLegendColors,
           border    = list(matrix = TRUE),
           scale     = "none", #"row",
           distfun   = "euclidean", hclustfun="complete", ## Clustering options distfun="correlation", hclustfun="average"
           cexRow    = 1, ## Character sizes
           cexCol    = 0.7,
           col       = WGCNA::blueWhiteRed(100), ## Color map scheme
           treeheight= 80,
           Rowv      = TRUE, Colv=TRUE
           
  ) #
  dev.off()
}

#MDS plots
createMDS<-function(datInput.MDS, case, threshold){
  x               <- data.frame(sapply(datInput.MDS, function(x) as.numeric(as.character(x)))); rownames(x)<- rownames(datInput.MDS)
  yCol            <-as.data.frame(matrix(drugStatus)); colnames(yCol)<-"drugStatus"
  yCol$GroupColor[yCol$drugStatus=="Placebo"]<-"darkgreen"
  yCol$GroupColor[yCol$drugStatus=="Drug"]<-"darkred"
  yCol$GroupColor[yCol$drugStatus=="100 mg"]<-"darkred"
  yCol$GroupColor[yCol$drugStatus=="300 mg"]<-"darkturquoise"
  yCol$GroupColor[yCol$drugStatus=="40 mg"]<-"darkred"
  yCol$GroupColor[yCol$drugStatus=="80 mg"]<-"darkturquoise"
  
  jpeg(file=paste0(global.datExplrStatRoot, FileBaseName, "_MDS_p",threshold,".jpeg"), width=17, height=15, units="cm", res=400)
  limma::plotMDS(x,col="black",lwd=2,cex=2.25,bg=yCol$GroupColor,pch=21,main=paste0("MDS plot based on protein filtered for significance p<", threshold))
  legend("topright",unique(yCol$drugStatus),fill=unique(yCol$GroupColor))
  dev.off()
}

createMDS_Flikr<-function(datInput.MDS, case, threshold){
  x               <- data.frame(sapply(datInput.MDS, function(x) as.numeric(as.character(x)))); rownames(x)<- rownames(datInput.MDS)
  yCol            <-as.data.frame(drugStatus)
  yCol$GroupColor[yCol$drugStatus=="Baseline"]<-"darkturquoise"
  yCol$GroupColor[yCol$drugStatus=="Drug"]<-"darkred"
  yCol$GroupColor[yCol$drugStatus=="4"]<-"darkred"
  yCol$GroupColor[yCol$drugStatus=="8"]<-"darkgreen"
  jpeg(file=paste0(global.datExplrStatRoot, FileBaseName, "_MDS_p",threshold,".jpeg"))
  limma::plotMDS(x,col="black",lwd=2,cex=2.25,bg=yCol$GroupColor,pch=21,main=paste0("MDS plot based on proteins filtered for significance p<", threshold))
  legend("topright",unique(yCol$drugStatus),fill=unique(yCol$GroupColor))
  dev.off()
}



#===================================================================================
#X.GENERAL helper functions
#===================================================================================

#--------------
# CONVERT GENES FROM SPECIES to HUMAN HOMOLOGS
#--------------
if (FALSE){
  
  library(dplyr)
  library(biomaRt)
  
  mouse_human_genes       = read.csv("http://www.informatics.jax.org/downloads/reports/HOM_MouseHumanSequence.rpt",sep="\t")
  mouse_rat_human_genes   = read.csv("http://www.informatics.jax.org/downloads/reports/HOM_AllOrganism.rpt",sep="\t")
  write.csv(mouse_rat_human_genes, "Human_Mouse_Rat_Homolog_dict.csv")
  
  indexUnique             =  unique(mouse_rat_human_genes$DB.Class.Key)
  tmpOutHuman             =  mouse_rat_human_genes[which(mouse_rat_human_genes$DB.Class.Key==indexUnique & mouse_rat_human_genes$Common.Organism.Name=="human"),]
  tmpOutrat               =  mouse_rat_human_genes[which(mouse_rat_human_genes$Common.Organism.Name=="rat"),]
  tmpOutmouse             =  mouse_rat_human_genes[which(mouse_rat_human_genes$Common.Organism.Name=="mouse, laboratory"),]
  tmpOutHumanMouseRat     =  mouse_rat_human_genes[which(mouse_rat_human_genes$DB.Class.Key==tmpOutHuman$DB.Class.Key & mouse_rat_human_genes$Common.Organism.Name=="mouse, laboratory"),]
  
  convert_mouse_to_human <- function(gene_list){
    
    output = c()
    
    for(gene in gene_list){
      class_key = (mouse_human_genes %>% filter(Symbol == gene & Common.Organism.Name=="mouse, laboratory"))[['DB.Class.Key']]
      if(!identical(class_key, integer(0)) ){
        human_genes = (mouse_human_genes %>% filter(DB.Class.Key == class_key & Common.Organism.Name=="human"))[,"Symbol"]
        for(human_gene in human_genes){
          output = append(output,human_gene)
        }
      }
    }
    
    return (output)
  }
  
  genes <- convert_mouse_to_human(musGenes)
}


#-------------------------------------------------------GENERAL HELPER FUNCTIONS---------------------------------------------------------------------#

labels2colors <- function (labels, zeroIsGrey = TRUE, colorSeq = NULL, naColor = "grey", commonColorCode = TRUE)  #small function from WGCNA
{
  if (is.null(colorSeq)) colorSeq = 
      c("turquoise", "blue", "brown", "yellow", "green", "red", "black", "pink", "magenta", "purple", "greenyellow", "tan", "salmon", "cyan", "midnightblue", "lightcyan", "grey60", "lightgreen", "lightyellow", "royalblue",
        "darkred", "darkgreen", "darkturquoise", "darkgrey", "orange", "darkorange", "white", "skyblue", "saddlebrown", "steelblue", "paleturquoise", "violet", "darkolivegreen", "darkmagenta", "sienna3", "yellowgreen",
        "skyblue3", "plum1", "orangered4", "mediumpurple3", "lightsteelblue1", "lightcyan1", "ivory", "floralwhite", "darkorange2", "brown4", "bisque4", "darkslateblue", "plum2", "thistle2", "thistle1", "salmon4",
        "palevioletred3", "navajowhite2", "maroon", "lightpink4", "lavenderblush3", "honeydew1", "darkseagreen4", "coral1", "antiquewhite4", "coral2", "mediumorchid", "skyblue2", "yellow4", "skyblue1", "plum", "orangered3",
        "mediumpurple2", "lightsteelblue", "lightcoral", "indianred4", "firebrick4", "darkolivegreen4", "brown2", "blue2", "darkviolet", "plum3", "thistle3", "thistle", "salmon2", "palevioletred2", "navajowhite1", "magenta4",
        "lightpink3", "lavenderblush2", "honeydew", "darkseagreen3", "coral", "antiquewhite2", "coral3", "mediumpurple4", "skyblue4", "yellow3", "sienna4", "pink4", "orangered1", "mediumpurple1", "lightslateblue",
        "lightblue4", "indianred3", "firebrick3", "darkolivegreen2", "blueviolet", "blue4", "deeppink", "plum4", "thistle4", "tan4", "salmon1", "palevioletred1", "navajowhite", "magenta3", "lightpink2", "lavenderblush1",
        "green4", "darkseagreen2", "chocolate4", "antiquewhite1", "coral4", "mistyrose", "slateblue", "yellow2", "sienna2", "pink3", "orangered", "mediumpurple", "lightskyblue4", "lightblue3", "indianred2", "firebrick2",
        "darkolivegreen1", "blue3", "brown1", "deeppink1", "powderblue", "tomato", "tan3", "royalblue3", "palevioletred", "moccasin", "magenta2", "lightpink1", "lavenderblush", "green3", "darkseagreen1", "chocolate3",
        "aliceblue", "cornflowerblue", "navajowhite3", "slateblue1", "whitesmoke", "sienna1", "pink2", "orange4", "mediumorchid4", "lightskyblue3", "lightblue2", "indianred1", "firebrick", "darkgoldenrod4", "blue1",
        "brown3", "deeppink2", "purple2", "tomato2", "tan2", "royalblue2", "paleturquoise4", "mistyrose4", "magenta1", "lightpink", "lavender", "green2", "darkseagreen", "chocolate2", "antiquewhite", "cornsilk",
        "navajowhite4", "slateblue2", "wheat3", "sienna", "pink1", "orange3", "mediumorchid3", "lightskyblue2", "lightblue1", "indianred", "dodgerblue4", "darkgoldenrod3", "blanchedalmond", "burlywood", "deepskyblue", "red1",
        "tomato4", "tan1", "rosybrown4", "paleturquoise3", "mistyrose3", "linen", "lightgoldenrodyellow", "khaki4", "green1", "darksalmon", "chocolate1", "antiquewhite3", "cornsilk2", "oldlace", "slateblue3", "wheat1",
        "seashell4", "peru", "orange2", "mediumorchid2", "lightskyblue1", "lightblue", "hotpink4", "dodgerblue3", "darkgoldenrod1", "bisque3", "burlywood1", "deepskyblue4", "red4", "turquoise2", "steelblue4", "rosybrown3",
        "paleturquoise1", "mistyrose2", "limegreen", "lightgoldenrod4", "khaki3", "goldenrod4", "darkorchid4", "chocolate", "aquamarine", "cyan1", "orange1", "slateblue4", "violetred4", "seashell3", "peachpuff4",
        "olivedrab4", "mediumorchid1", "lightskyblue", "lemonchiffon4", "hotpink3", "dodgerblue1", "darkgoldenrod", "bisque2", "burlywood2", "dodgerblue2", "rosybrown2", "turquoise4", "steelblue3", "rosybrown1",
        "palegreen4", "mistyrose1", "lightyellow4", "lightgoldenrod3", "khaki2", "goldenrod3", "darkorchid3", "chartreuse4", "aquamarine1", "cyan4", "orangered2", "snow", "violetred2", "seashell2", "peachpuff3",
        "olivedrab3", "mediumblue", "lightseagreen", "lemonchiffon3", "hotpink2", "dodgerblue", "darkblue", "bisque1", "burlywood3", "firebrick1", "royalblue1", "violetred1", "steelblue1", "rosybrown", "palegreen3",
        "mintcream", "lightyellow3", "lightgoldenrod2", "khaki1", "goldenrod2", "darkorchid2", "chartreuse3", "aquamarine2", "darkcyan", "orchid", "snow2", "violetred", "seashell1", "peachpuff2", "olivedrab2",
        "mediumaquamarine", "lightsalmon4", "lemonchiffon2", "hotpink1", "deepskyblue3", "cyan3", "bisque", "burlywood4", "forestgreen", "royalblue4", "violetred3", "springgreen3", "red3", "palegreen1", "mediumvioletred",
        "lightyellow2", "lightgoldenrod1", "khaki", "goldenrod1", "darkorchid1", "chartreuse2", "aquamarine3", "darkgoldenrod2", "orchid1", "snow4", "turquoise3", "seashell", "peachpuff1", "olivedrab1", "maroon4",
        "lightsalmon3", "lemonchiffon1", "hotpink", "deepskyblue2", "cyan2", "beige", "cadetblue", "gainsboro", "salmon3", "wheat", "springgreen2", "red2", "palegreen", "mediumturquoise", "lightyellow1", "lightgoldenrod",
        "ivory4", "goldenrod", "darkorchid", "chartreuse1", "aquamarine4", "darkkhaki", "orchid3", "springgreen1", "turquoise1", "seagreen4", "peachpuff", "olivedrab", "maroon3", "lightsalmon2", "lemonchiffon", "honeydew4",
        "deepskyblue1", "cornsilk4", "azure4", "cadetblue1", "ghostwhite", "sandybrown", "wheat2", "springgreen", "purple4", "palegoldenrod", "mediumspringgreen", "lightsteelblue4", "lightcyan4", "ivory3", "gold3",
        "darkorange4", "chartreuse", "azure", "darkolivegreen3", "palegreen2", "springgreen4", "tomato3", "seagreen3", "papayawhip", "navyblue", "maroon2", "lightsalmon1", "lawngreen", "honeydew3", "deeppink4", "cornsilk3",
        "azure3", "cadetblue2", "gold", "seagreen", "wheat4", "snow3", "purple3", "orchid4", "mediumslateblue", "lightsteelblue3", "lightcyan3", "ivory2", "gold2", "darkorange3", "cadetblue4", "azure1", "darkorange1",
        "paleturquoise2", "steelblue2", "tomato1", "seagreen2", "palevioletred4", "navy", "maroon1", "lightsalmon", "lavenderblush4", "honeydew2", "deeppink3", "cornsilk1", "azure2", "cadetblue3", "gold4", "seagreen1",
        "yellow1", "snow1", "purple1", "orchid2", "mediumseagreen", "lightsteelblue2", "lightcyan2", "ivory1", "gold1") #WGCNA ordered standardColors()
  
  if (is.numeric(labels)) {
    if (zeroIsGrey) minLabel = 0
    else minLabel = 1
    if (any(labels < 0, na.rm = TRUE)) minLabel = min(c(labels), na.rm = TRUE)
    nLabels = labels
  }
  else {
    if (commonColorCode) {
      factors = factor(c(as.matrix(as.data.frame(labels))))
      nLabels = as.numeric(factors)
      dim(nLabels) = dim(labels)
    }
    else {
      labels = as.matrix(as.data.frame(labels))
      factors = list()
      for (c in 1:ncol(labels)) factors[[c]] = factor(labels[, c])
      nLabels = sapply(factors, as.numeric)
    }
  }
  if (max(nLabels, na.rm = TRUE) > length(colorSeq)) {
    nRepeats = as.integer((max(labels) - 1)/length(colorSeq)) + 1
    warning(paste0("Number of labels exceeds number of available colors. Some colors will be repeated ", nRepeats, " times."))
    extColorSeq = colorSeq
    for (rep in 1:nRepeats) extColorSeq = c(extColorSeq, paste(colorSeq, ".", rep, sep = ""))
  }
  else {
    nRepeats = 1
    extColorSeq = colorSeq
  }
  colors = rep("grey", length(nLabels))
  fin = !is.na(nLabels)
  colors[!fin] = naColor
  finLabels = nLabels[fin]
  colors[fin][finLabels != 0] = extColorSeq[finLabels[finLabels != 0]]
  if (!is.null(dim(labels))) dim(colors) = dim(labels)
  colors
}


################USEFUL REFERENCES###############################

if(FALSE){#-------------------------------------------------------
  #group <- NA
  #group[as.numeric(df$y) < 2]  <- 1
  #group[as.numeric(df$y) >=2 ] <- 2
  #pairs(df, col=c("red", "black")[group])
  colors <- c("red", "black")[unclass(df$y)]
  pairs(df, col=colors)
}

#SPLIT DATA INTO TRAINING & TESTING COHORTS
if (FALSE){
  df                  <- df[order(df$y),]
  df_Dat_idx          <- createDataPartition(df$y, p = 0.8, list = FALSE)
  df_train            <- df[df_Dat_idx, ]
  df_test             <- df[-df_Dat_idx, ]
  #ONE HOT ENCODING
  # dummies_model       <- dummyVars(y ~ ., data=df_train)
  # trainData           <- predict(dummies_model, newdata = df_train)
  # df_train            <- data.frame(trainData)
  featurePlot(x = df_train[, 2:dim(df_train)[2]], 
              y = df_train$y, 
              plot = "box",
              strip=strip.custom(par.strip.text=list(cex=.7)),
              scales = list(x = list(relation="free"), 
                            y = list(relation="free")))
  featurePlot(x = df_train[, 2:dim(df_train)[2]], 
              y = df_train$y, 
              plot = "density",
              strip=strip.custom(par.strip.text=list(cex=.7)),
              scales = list(x = list(relation="free"), 
                            y = list(relation="free")))
}

# #VENN 
# set.seed(20190708)
# genes <- paste("gene",1:1000,sep="")
# x <- list(
#   A = sample(genes,300), 
#   B = sample(genes,525), 
#   C = sample(genes,440),
#   D = sample(genes,350)
# )
# 
# if (!require(devtools)) install.packages("devtools")
# devtools::install_github("yanlinlin82/ggvenn")
# 
# library(ggvenn)
# ggvenn(
#   x, 
#   fill_color = c("#0073C2FF", "#EFC000FF", "#868686FF", "#CD534CFF"),
#   stroke_size = 0.5, set_name_size = 4
# )
# 
# #SHINE A
# data  <- read.csv("C:/Users/kiran/Box/02_EMTHERAPRO_DATA & ANALYTICS/2.OUTPUT/2023_05_COGRX_SHINEA_PLASMA_HEP/CSF_PLASMA_PROTEINS.csv")
# x <- list(
#   CSF = data[,1], 
#   T14 = data[,2], 
#   HEP = data[,3]
# )
# y <- list(
#   T14 = data[,2], 
#   HEP = data[,3]
# )
# 

if(FALSE){
  #EISAI
  data1  <- read.csv("C:/Users/kiran/Desktop/Eisai_Correlations/2023.08.09_DUNK_MRM_Targets/Venn_Anova_Ancova_80mg.csv")
  data2  <- read.csv("C:/Users/kiran/Desktop/Eisai_Correlations/2023.08.09_DUNK_MRM_Targets/Venn_Anova_Ancova_80mg_ancova.csv")
  data3  <- read.csv("C:/Users/kiran/Desktop/Eisai_Correlations/2023.08.09_DUNK_MRM_Targets/Venn_Anova_Ancova_40mg.csv")
  data4  <- read.csv("C:/Users/kiran/Desktop/Eisai_Correlations/2023.08.09_DUNK_MRM_Targets/Venn_Anova_Ancova_40_80mg.csv")
  
  x <- list(
    p_anova_80mg        = (data1[,1]),
    p_ancova_80mg       = (data2[,1]),
    p_anova_40mg        = (data3[,1]),
    p_anova_40_80mg     = (data4[,1])
  )
  
  if (!require(devtools)) install.packages("devtools")
  devtools::install_github("yanlinlin82/ggvenn")
  
  library(ggvenn)
  ggvenn(
    x,
    fill_color = c("#0073C2FF", "#EFC000FF", "#868686FF", "#CD534CFF"),
    stroke_size = 0.5, set_name_size = 4
  )
  # 
  # ggvenn(
  #   y, 
  #   fill_color = c("#0073C2FF", "#EFC000FF", "#868686FF", "#CD534CFF"),
  #   stroke_size = 0.5, set_name_size = 4
  # )
  
  install.packages("VennDiagram")
  library(VennDiagram)
  venn.diagram(x, filename = "venn-4-dimensions.png")
  # Helper function to display Venn diagram
  display_venn <- function(x, ...){
    library(VennDiagram)
    grid.newpage()
    venn_object <- venn.diagram(x, filename = NULL, ...)
    grid.draw(venn_object)
  }
  # Four dimension Venn plot
  display_venn(x)
}