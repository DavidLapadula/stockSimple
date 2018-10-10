const mongoose = require('mongoose');
const passport = require('passport');
const settings = require('../config/settings');
require('../config/passport')(passport);
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const User = require("../models/Users");
const Watchlist = require("../models/Watchlists");
const db = require('../models');
const axios = require('axios');
const stockAPIControllers = require("./stockAPIControllers");

// Helper function to check for valid email addresses
// Obtained from https://emailregex.com/
function validateEmail(email) {
  let re = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  return re.test(String(email).toLowerCase());
}

// Takes in an array of stock tickers which may contain duplicates. Returns an array with any duplicate entries removed.
// This is used to obtain new info for all of the tickers used in the user's watchlists, to optimize the api calls to the stock website
function removeDuplicatesFromArray(allTickers) {
  var result_array = [];

  var len = allTickers.length;
  console.log(`allTickers.length: ${len}`);
  var assoc = {};

  while (len--) {
    var item = allTickers[len];

    if (!assoc[item]) {
      result_array.unshift(item);
      assoc[item] = true;
    }
  }

  return result_array;
}

// This function will take recent and historical stock API data, and convert it to an array of objects to return to the front end.
// The formatting of the object data returned from here will make the code much cleaner on the front end.
// Oct 9 Note: It may be better/cleaner to move this function to the stockAPI controller and just call it like stockAPIControllers.createStockSummaryData()
// https://zellwk.com/blog/looping-through-js-objects/
function createStockSummaryData(recentData, historicalData) {

  let arrayOfNicelyFormattedData = [];
  let arrayOfTickers = []; // holds all the tickers that we are dealing with. Used later to combine the objects

  let { data: recent } = recentData;

  // For each recent data object
  recent.map(function (recentTicker) {

    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/assign
    //arrayOfNicelyFormattedData[recentTicker.symbol] = Object.assign(newNicelyFormattedObject, recentTicker);
    arrayOfNicelyFormattedData[recentTicker.symbol] = recentTicker;
    arrayOfTickers.push(recentTicker.symbol);
  });

  // Now we need to loop through the historical data and build something nice
  let allHistoryObjects = [];
  for (let ticker in historicalData) {

    let newHistoryObject = {};

    // Define the properties in the object as arrays, so that we can use array.push later
    newHistoryObject.historyDates = [];
    newHistoryObject.historyOpen = [];
    newHistoryObject.historyClose = [];
    newHistoryObject.historyHigh = [];
    newHistoryObject.historyLow = [];
    newHistoryObject.historyVolume = [];

    // Each object in the history property of the returned API data is a day in the date range
    // each day property contains an object with open, close, etc. (see below)
    // In order to use chart.js on the front end, the data must be in arrays, so we convert it accordingly below
    for (let tickerDate in historicalData[ticker].history) {

      newHistoryObject.ticker = historicalData[ticker].ticker;
      newHistoryObject.historyDates.push(tickerDate);
      newHistoryObject.historyOpen.push(historicalData[ticker].history[tickerDate].open);
      newHistoryObject.historyClose.push(historicalData[ticker].history[tickerDate].close);
      newHistoryObject.historyHigh.push(historicalData[ticker].history[tickerDate].high);
      newHistoryObject.historyLow.push(historicalData[ticker].history[tickerDate].low);
      newHistoryObject.historyVolume.push(historicalData[ticker].history[tickerDate].volume);
    }

    allHistoryObjects[historicalData[ticker].ticker] = newHistoryObject;
  }

  // Now we combine the objects created into one for each ticker. They data can be later accessed from this array by using the ticker as the key
  for (let symbol in arrayOfTickers){
    arrayOfNicelyFormattedData[arrayOfTickers[symbol]].historyDates = allHistoryObjects[arrayOfTickers[symbol]].historyDates;
    arrayOfNicelyFormattedData[arrayOfTickers[symbol]].historyOpen = allHistoryObjects[arrayOfTickers[symbol]].historyOpen;
    arrayOfNicelyFormattedData[arrayOfTickers[symbol]].historyClose = allHistoryObjects[arrayOfTickers[symbol]].historyClose;
    arrayOfNicelyFormattedData[arrayOfTickers[symbol]].historyHigh = allHistoryObjects[arrayOfTickers[symbol]].historyHigh;
    arrayOfNicelyFormattedData[arrayOfTickers[symbol]].historyLow = allHistoryObjects[arrayOfTickers[symbol]].historyLow;
    arrayOfNicelyFormattedData[arrayOfTickers[symbol]].historyVolume = allHistoryObjects[arrayOfTickers[symbol]].historyVolume;
  }

  //console.log("allHistoryObjects: ", arrayOfNicelyFormattedData);

  return arrayOfNicelyFormattedData;
}


// Defining methods for the authorizeController
module.exports = {

  // controller for creating a new user
  create: function (req, res) {
    if (!req.body.age) {
      res.json({ success: false, msg: 'You must be 16 or older to use this app!' });
    } else if (!req.body.name || !req.body.password) {
      res.json({ success: false, msg: 'Your email, password, or username is incomplete.' });
    } else if (req.body.password.length < 12) {
      res.json({ success: false, msg: 'Your password must be at least 12 characters long.' });
    } else if (!validateEmail(req.body.email)) {
      res.json({ success: false, msg: 'That is not a valid email address' });
    } else {
      let newUser = new User({
        name: req.body.name,
        email: req.body.email,
        password: req.body.password,
        ofAge: req.body.age
      });

      let defaultWatchlists = [
        {
          name: 'Technology',
          stocks: ['AAPL', 'AMZN', 'MSFT', 'MU', 'AMD']
        },
        {
          name: 'Banking & Credit',
          stocks: ['V', 'MA', 'AXP', 'BAC', 'RY']
        },
        {
          name: 'Favourites',
          stocks: ['AAPL', 'AMZN', 'CGC', 'CSIQ', 'SHOP-CA']
        },
      ]
      // save the user
      newUser.save()
        .then(result => {

          //loop over default watchlists, create one for each value and push the id of default watchlist into the new users 'watchlist' property as a reference
          defaultWatchlists.forEach((watchlists) => {

            let newWatchlist = new Watchlist({
              name: watchlists.name,
              stocks: watchlists.stocks
            });

            newWatchlist.save()
              .then(newWatchId => {
                db.User.findOneAndUpdate({ _id: result._id }, { $push: { watchlists: newWatchId._id } }, { new: true }, function (err, res) {
                  if (err) {
                    console.log(err)
                  }
                });
              })
          })

        })
        .then(result => {
          res.json({ success: true, msg: 'Sign up complete' });
        })
        .catch((err) => {
          // 11000 is the error code for no duplicates in MongoDB
          if (err.code === 11000) {
            res.send({ success: false, msg: 'That email is already in use' });
          } else {
            res.send({ success: false, msg: 'Server Error' });
          }
        })
    }
  },

  //controller for login. checks for existing email and compares password
  // user info is passed to front end through 'token' after password is compared
  // token passed to front end contains user info that is used to save id to local storage
  login: function (req, res) {
    User.findOne({
      email: req.body.email
    }, function (err, user) {
      if (err) throw err;

      if (!user) {
        res.status(401).send({ success: false, msg: 'Authentication failed. User not found.' });
      } else {
        // check if password matches
        user.comparePassword(req.body.password, function (err, isMatch) {
          if (isMatch && !err) {
            // if user is found and password is right create a token
            var token = jwt.sign(user.toJSON(), settings.secret);
            // return the information including token as JSON
            res.json({ success: true, token: 'JWT ' + token, id: user._id });
          } else {
            res.status(401).send({ success: false, msg: 'Authentication failed. Wrong password.' });
          }
        });
      }
    });
  },
  //controller for grabbing all user related data once the user has logged in
  loadData: function (req, res) {

    //let API_KEY = "3whtIE7gSVsKL2UEDgl0dBbE3b1jbMcvJOYjSu2fxcHSZwWTw15yGeEMwo27";

    // read from database and get all user info
    db.User.find({ _id: req.params.userID })
      .populate("articles")
      .populate("investments")
      .populate("watchlists")
      .then((userDBInfo) => {

        // There are two types of data that we're retrieving here: watchlists and investments; they will be handled separately.
        // For watchlists, we get a list of all the user's watchlists and the associated tickers/symbols, and
        // then create an array of unique entries which will be used to query the stock API. There's no need to query the same ticker multiple times. Efficiency!

        // watchlist info. Iterate through each watchlist and add the assigned tickers to the allWatchlistTickers array
        let allWatchlistTickers = [];
        if (userDBInfo[0].watchlists.length) {
          userDBInfo[0].watchlists.forEach((watchlist) => {
            //console.log("watchlist stocks: ", watchlist.stocks); // gives each watchlist array, like: ["V","MA","AXP","BAC","RY"]
            allWatchlistTickers = [...watchlist.stocks, ...allWatchlistTickers]; // concatenate each array of tickers from each watchlist into one master array
            // https://blog.toshima.ru/2017/03/24/es6-array-merge.html
          });
        }

        // remove any duplicated ticker from the master watchlist array. Better efficiency for the eventual external API call.
        let uniqueWatchlistTickers = removeDuplicatesFromArray(allWatchlistTickers);
        //console.log("uniqueWatchlistTickers: ", uniqueWatchlistTickers, uniqueWatchlistTickers.length);


        // Now we will create variables to hold the results of the axios calls (which returns a promise), and call promise.all below 
        // so that we can be sure all the results have been obtained before continuing
        let readRecentStockInfo = stockAPIControllers.getLatestStockInfoAllTickers(uniqueWatchlistTickers); // returns a promise

        // for the purposes of this project, and due to time limitations, we will be only getting historical info back to the beginning of Sept 2018
        // By leaving the end date empty, it will show the stock into up to the current date
        let startDate = "2018-09-01";
        let endDate = "";
        let readHistoricalStockInfo = stockAPIControllers.getHistoricalInfoAllTickers(uniqueWatchlistTickers, startDate, endDate); //returns a promise

        // Using Promise.all, we wait until the recent and historical stock queries have completed,
        // then we combine that data into an easy-to-use array of objects that the front end can take care of displaying
        // https://stackoverflow.com/questions/28250680/how-do-i-access-previous-promise-results-in-a-then-chain
        Promise.all([readRecentStockInfo, readHistoricalStockInfo])
          .then(([resultRecentStockInfo, resultHistoricalStockInfo]) => {

            // call a function which puts the two results into an array of objects that is easier to consume on the front end
            return createStockSummaryData(resultRecentStockInfo, resultHistoricalStockInfo);

          })
          .then((nicelyFormattedData) => {
            console.log("nicelyFormattedData", nicelyFormattedData);
          });


        // investment info
        let tickerString = [];
        // if the user has any investments, populate and array with their ticker value 
        // return the array joined to a string and the user id
        if (userDBInfo[0].investments.length) {
          userDBInfo[0].investments.forEach((investment) => {
            tickerString.push(investment.ticker)
          })
          return { tickerString: tickerString.join(), userInfo: userDBInfo }

        } else {
          return { userInfo: userDBInfo }
        }
      })

      // Oct 9: the code below has not yet been modified to pass the ful recent/historical data for each ticker
      // Do this on Oct 10th
      .then((tickerString) => {

        // if the user has investments, use the returned string to generate a query
        if (tickerString.tickerString) {
          axios.get(`https://www.worldtradingdata.com/api/v1/stock?symbol=${tickerString.tickerString}&api_token=${API_KEY}`)
            .then((stock) => {
              let currentPriceArray = [];
              // make an array of objects with the ticker value and price  of ech returned stock
              stock.data.data.forEach((stock) => {
                currentPriceArray.push({ currentPrice: stock.price, ticker: stock.symbol })
              })

              // add the current price to the investment object passed back to the user
              for (let i = 0; i < currentPriceArray.length; i++) {
                for (let j = 0; j < tickerString.userInfo[0].investments.length; j++) {
                  if (currentPriceArray[i].ticker === tickerString.userInfo[0].investments[j].ticker) {
                    tickerString.userInfo[0].investments[j].currentPrice = currentPriceArray[i].currentPrice
                  }
                }
              }

              let userInfo = {};
              userInfo.name = tickerString.userInfo[0].name;
              userInfo.investments = tickerString.userInfo[0].investments;
              userInfo.articles = tickerString.userInfo[0].articles;
              userInfo.watchlists = tickerString.userInfo[0].watchlists;
              res.send(userInfo);
            })
            .catch((err) => {
              res.send({ success: false, msg: ' Authentication Internal Error.' });
            });

          // if no investments, then return the user info as is from the db
        } else {
          let userInfo = {};
          userInfo.name = tickerString.userInfo[0].name;
          userInfo.investments = tickerString.userInfo[0].investments;
          userInfo.articles = tickerString.userInfo[0].articles;
          userInfo.watchlists = tickerString.userInfo[0].watchlists;
          res.send(userInfo);
        }
      })
      .catch((err) => {
        res.send({ success: false, msg: 'Server Error' });
      })

  }
}

